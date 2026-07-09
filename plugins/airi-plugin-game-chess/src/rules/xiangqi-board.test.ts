import { describe, expect, it } from 'vitest'

import {
  parseXiangqiFenPieces,
  XIANGQI_COLS,
  XIANGQI_ROWS,
  xiangqiSideToMove,
  xiangqiSquareAt,
} from './xiangqi-board'

const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1'

describe('xiangqi board helpers', () => {
  it('describes a 9x10 grid with top-down square labels', () => {
    expect(XIANGQI_COLS).toBe(9)
    expect(XIANGQI_ROWS).toBe(10)
    // Top edge is Black's back rank (rank 9); bottom edge is Red's (rank 0).
    expect(xiangqiSquareAt(0, 0)).toBe('a9')
    expect(xiangqiSquareAt(4, 0)).toBe('e9')
    expect(xiangqiSquareAt(4, 9)).toBe('e0')
    expect(xiangqiSquareAt(8, 9)).toBe('i0')
  })

  it('parses the starting placement into 32 pieces', () => {
    const pieces = parseXiangqiFenPieces(START_FEN)
    expect(pieces).toHaveLength(32)
  })

  it('places the two generals on their starting squares', () => {
    const pieces = parseXiangqiFenPieces(START_FEN)
    expect(pieces.find(p => p.square === 'e9')?.piece).toEqual({ side: 'second', role: 'k' })
    expect(pieces.find(p => p.square === 'e0')?.piece).toEqual({ side: 'first', role: 'k' })
  })

  it('maps FEN case to side: uppercase is Red (first)', () => {
    const pieces = parseXiangqiFenPieces(START_FEN)
    expect(pieces.find(p => p.square === 'a0')?.piece).toEqual({ side: 'first', role: 'r' })
    expect(pieces.find(p => p.square === 'a9')?.piece).toEqual({ side: 'second', role: 'r' })
    // Cannons sit on rank 2 (Red) and rank 7 (Black).
    expect(pieces.find(p => p.square === 'b2')?.piece).toEqual({ side: 'first', role: 'c' })
    expect(pieces.find(p => p.square === 'b7')?.piece).toEqual({ side: 'second', role: 'c' })
  })

  it('reads the active colour from the FEN', () => {
    expect(xiangqiSideToMove(START_FEN)).toBe('first')
    expect(xiangqiSideToMove('9/9/9/9/9/9/9/9/9/9 b - - 0 1')).toBe('second')
  })
})
