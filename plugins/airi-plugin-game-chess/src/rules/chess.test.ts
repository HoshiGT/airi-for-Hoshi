import { describe, expect, it } from 'vitest'

import { createChessRules } from './chess'

describe('createChessRules', () => {
  it('exposes an 8x8 board with top-down square labels', () => {
    const rules = createChessRules()
    expect(rules.cols).toBe(8)
    expect(rules.rows).toBe(8)
    expect(rules.squareAt(4, 6)).toBe('e2')
    expect(rules.squareAt(4, 4)).toBe('e4')
    expect(rules.squareAt(0, 0)).toBe('a8')
    expect(rules.squareAt(7, 7)).toBe('h1')
  })

  it('reports the opening position state', () => {
    const rules = createChessRules()
    expect(rules.turn()).toBe('first')
    expect(rules.legalMoves()).toHaveLength(20)
    expect(rules.isCheck()).toBe(false)
    expect(rules.isGameOver()).toBe(false)
    expect(rules.result()).toBe('*')
    expect(rules.pieces()).toHaveLength(32)
    expect(rules.pieceAt('e2')).toEqual({ side: 'first', role: 'p' })
  })

  it('lists destinations from a square', () => {
    const rules = createChessRules()
    const fromE2 = rules.legalMovesFrom('e2').map(move => move.to).sort()
    expect(fromE2).toEqual(['e3', 'e4'])
  })

  it('applies a UCI move and advances the side to move', () => {
    const rules = createChessRules()
    const applied = rules.move('e2e4')
    expect(applied).toEqual({ from: 'e2', to: 'e4', uci: 'e2e4', san: 'e4', promotion: undefined })
    expect(rules.turn()).toBe('second')
    expect(rules.pieceAt('e2')).toBeNull()
    expect(rules.pieceAt('e4')).toEqual({ side: 'first', role: 'p' })
  })

  it('rejects an illegal move without mutating the board', () => {
    const rules = createChessRules()
    const before = rules.fen()
    expect(rules.move('e2e5')).toBeNull()
    expect(rules.fen()).toBe(before)
  })

  it('detects checkmate and reports the winner (fool\'s mate)', () => {
    const rules = createChessRules()
    // 1. f3 e5 2. g4 Qh4# — White is mated, so Black (second) wins.
    expect(rules.move('f2f3')).not.toBeNull()
    expect(rules.move('e7e5')).not.toBeNull()
    expect(rules.move('g2g4')).not.toBeNull()
    expect(rules.move('d8h4')).not.toBeNull()
    expect(rules.isGameOver()).toBe(true)
    expect(rules.isCheck()).toBe(true)
    expect(rules.result()).toBe('0-1')
  })
})
