import type { EngineCandidate } from './shared'

import { describe, expect, it } from 'vitest'

import { selectMove } from './move-policy'

function cand(uci: string, scoreCp: number, rank: number): EngineCandidate {
  return { uci, san: uci, rank, scoreCp }
}

function mate(uci: string, mateIn: number, rank: number): EngineCandidate {
  return { uci, san: uci, rank, mate: mateIn }
}

// The policy decides how hard Airi plays from the engine's ranked candidates,
// whose scores are already from Airi's (side-to-move) perspective.
describe('selectMove adaptive strength', () => {
  it('always plays the best move at master level', () => {
    const choice = selectMove([cand('e2e4', 800, 1), cand('d2d4', 200, 2)], 'master')
    expect(choice?.uci).toBe('e2e4')
    expect(choice?.intent).toBe('serious')
    expect(choice?.chosenCp).toBe(800)
  })

  it('eases a winning position toward a beginner-sized lead', () => {
    // Best is +800; the policy steers toward the beginner target (~ -60).
    const choice = selectMove([cand('e2e4', 800, 1), cand('g1f3', 100, 2), cand('b1c3', -40, 3)], 'beginner')
    expect(choice?.uci).toBe('b1c3')
    expect(choice?.intent).toBe('ease')
    expect(choice?.bestCp).toBe(800)
    expect(choice?.chosenCp).toBe(-40)
  })

  it('plays its best when already even or behind, even at beginner level', () => {
    const choice = selectMove([cand('e7e5', -200, 1), cand('d7d5', -350, 2)], 'beginner')
    expect(choice?.uci).toBe('e7e5')
    expect(choice?.intent).toBe('serious')
  })

  it('never eases past the safety floor — no deliberate blunder into a loss', () => {
    // The only softer move (-400) is below the beginner floor, so Airi keeps its best.
    const choice = selectMove([cand('e2e4', 800, 1), cand('h2h4', -400, 2)], 'beginner')
    expect(choice?.uci).toBe('e2e4')
    expect(choice?.intent).toBe('serious')
  })

  it('holds a larger lead for a stronger declared level', () => {
    const choice = selectMove([cand('e2e4', 800, 1), cand('g1f3', 300, 2), cand('b1c3', 100, 3)], 'advanced')
    expect(choice?.uci).toBe('g1f3')
    expect(choice?.intent).toBe('ease')
  })

  it('takes a forced mate when playing seriously', () => {
    const choice = selectMove([mate('d1h5', 2, 1), cand('f1c4', 500, 2)], 'master')
    expect(choice?.uci).toBe('d1h5')
  })

  it('returns null when there are no candidates', () => {
    expect(selectMove([], 'amateur')).toBeNull()
  })
})
