import type { PositionAnalysis } from './review'
import type { PlyRecord } from './use-chess-game'

import { describe, expect, it } from 'vitest'

import { classifyCpLoss, deriveReview, moverEvalCp } from './review'

function ply(uci: string, san: string): PlyRecord {
  return { uci, san, from: uci.slice(0, 2), to: uci.slice(2, 4) }
}

function position(evalCp: number, bestUci: string, bestSan = bestUci): PositionAnalysis {
  return { evalCp, bestUci, bestSan }
}

describe('moverEvalCp', () => {
  it('passes centipawn scores through and defaults missing scores to 0', () => {
    expect(moverEvalCp({ scoreCp: 123 })).toBe(123)
    expect(moverEvalCp({ scoreCp: -55 })).toBe(-55)
    expect(moverEvalCp({})).toBe(0)
  })

  it('folds mates under the mate ceiling, preferring shorter mates', () => {
    expect(moverEvalCp({ mate: 1 })).toBeGreaterThan(moverEvalCp({ mate: 3 }))
    expect(moverEvalCp({ mate: 1 })).toBeGreaterThan(moverEvalCp({ scoreCp: 5000 }))
    expect(moverEvalCp({ mate: -1 })).toBeLessThan(moverEvalCp({ mate: -3 }))
    expect(moverEvalCp({ mate: -2 })).toBeLessThan(moverEvalCp({ scoreCp: -5000 }))
  })
})

describe('classifyCpLoss', () => {
  it('grades by loss bands', () => {
    expect(classifyCpLoss(0, false)).toBe('best')
    expect(classifyCpLoss(20, false)).toBe('excellent')
    expect(classifyCpLoss(60, false)).toBe('good')
    expect(classifyCpLoss(120, false)).toBe('inaccuracy')
    expect(classifyCpLoss(250, false)).toBe('mistake')
    expect(classifyCpLoss(600, false)).toBe('blunder')
  })

  it('always grades the engine choice as best, whatever the measured loss', () => {
    expect(classifyCpLoss(80, true)).toBe('best')
  })
})

describe('deriveReview', () => {
  it('grades each ply from the eval swing between consecutive positions', () => {
    // A drawn two-ply game. Ply 0 measures against position 1's eval; ply 1
    // (the last move) measures against the terminal draw score 0.
    const plies = [ply('e2e4', 'e4'), ply('g8h6', 'Nh6')]
    const positions = [
      position(30, 'e2e4', 'e4'), // first to move: +0.3, best e4 (played)
      position(-10, 'g8f6', 'Nf6'), // second to move: -0.1 best; played Nh6 instead
    ]
    const review = deriveReview(plies, positions, '1/2-1/2')

    expect(review.plies).toHaveLength(2)

    // Ply 0 played the engine move → best. Its swing: best line +30, and after
    // the move the opponent stands -10, so the mover kept +10 → 20cp drifted.
    expect(review.plies[0].quality).toBe('best')
    expect(review.plies[0].cpLoss).toBe(20)
    expect(review.plies[0].evalAfterCp).toBe(10)
    expect(review.plies[0].betterSan).toBeUndefined()

    // Ply 1: best line -10, the terminal draw scores 0 → the move IMPROVED on
    // the best line (engine noise in real games); loss clamps to 0 → best band.
    expect(review.plies[1].side).toBe('second')
    expect(review.plies[1].cpLoss).toBe(0)
    expect(review.plies[1].quality).toBe('best')
  })

  it('marks a large giveaway as a blunder and surfaces the better move', () => {
    // First side hangs its queen: +50 best line, but after its move the
    // opponent's position evaluates +850 (mover POV) → played = -850.
    const plies = [ply('d1h5', 'Qh5'), ply('g6h5', 'gxh5')]
    const positions = [
      position(50, 'g1f3', 'Nf3'),
      position(850, 'g6h5', 'gxh5'),
    ]
    const review = deriveReview(plies, positions, '1/2-1/2')

    expect(review.plies[0].quality).toBe('blunder')
    expect(review.plies[0].cpLoss).toBe(50 + 850)
    expect(review.plies[0].betterSan).toBe('Nf3')
    expect(review.counts.first.blunder).toBe(1)
    expect(review.counts.second.blunder).toBe(0)
  })

  it('treats delivering mate as best and grades the mated side against the mate score', () => {
    // Ply 0 (first side) blunders into mate; ply 1 (second side) mates.
    const plies = [ply('f2f3', 'f3'), ply('d8h4', 'Qh4#')]
    const positions = [
      position(20, 'e2e4', 'e4'),
      position(9998, 'd8h4', 'Qh4#'), // mate in 1, mover POV
    ]
    const review = deriveReview(plies, positions, '0-1')

    // First side: best was +20 but the reply position is winning for second
    // (mate) → enormous loss.
    expect(review.plies[0].quality).toBe('blunder')
    // Second side: played the mating move the engine chose.
    expect(review.plies[1].quality).toBe('best')
    // Graph POV: after ply 1 the terminal eval is a first-side mate loss.
    expect(review.plies[1].evalAfterCp).toBeLessThan(-9000)
    expect(review.counts.first.blunder).toBe(1)
  })

  it('flips graph evaluations to the first side POV on both plies', () => {
    const plies = [ply('e2e4', 'e4'), ply('e7e5', 'e5')]
    const positions = [
      position(30, 'e2e4', 'e4'),
      position(-25, 'e7e5', 'e5'), // second to move sees -25
    ]
    const review = deriveReview(plies, positions, '1/2-1/2')

    // After ply 0 the analyzed eval is position 1's: -25 from second POV → +25 first POV.
    expect(review.plies[0].evalAfterCp).toBe(25)
    // After ply 1 the terminal draw is 0 either way.
    expect(review.plies[1].evalAfterCp).toBe(0)
  })
})
