import type { PlacedPiece, Side } from './shared'

import { describe, expect, it } from 'vitest'

import { xiangqiMoveName } from './xiangqi-notation'

/** Builds a position from `square:sideLetter+role` specs, e.g. 'h2:Rc' = red cannon on h2. */
function position(...specs: string[]): PlacedPiece[] {
  return specs.map((spec) => {
    const [square, piece] = spec.split(':')
    const side: Side = piece[0] === 'R' ? 'first' : 'second'
    return { square, piece: { side, role: piece[1] } }
  })
}

describe('xiangqiMoveName', () => {
  it('names the classic red cannon-to-centre opening 炮二平五', () => {
    expect(xiangqiMoveName(position('h2:Rc'), 'h2', 'e2')).toBe('炮二平五')
  })

  it('names a red pawn push 兵七进一', () => {
    expect(xiangqiMoveName(position('c3:Rp'), 'c3', 'c4')).toBe('兵七进一')
  })

  it('names a red horse development 马八进七', () => {
    expect(xiangqiMoveName(position('b0:Rn'), 'b0', 'c2')).toBe('马八进七')
  })

  it('reports step counts for straight movers: 车九进二', () => {
    expect(xiangqiMoveName(position('a0:Rr'), 'a0', 'a2')).toBe('车九进二')
  })

  it('uses Arabic numerals and black names for black: 砲8平5 and 馬8进7', () => {
    expect(xiangqiMoveName(position('h7:Bc'), 'h7', 'e7')).toBe('砲8平5')
    expect(xiangqiMoveName(position('h9:Bn'), 'h9', 'g7')).toBe('馬8进7')
  })

  it('measures 进 from each side toward its opponent: 卒3进1 and 象7进5', () => {
    // Black advances by DECREASING rank (rank 0 is red's back rank).
    expect(xiangqiMoveName(position('c6:Bp'), 'c6', 'c5')).toBe('卒3进1')
    expect(xiangqiMoveName(position('g9:Bb'), 'g9', 'e7')).toBe('象7进5')
  })

  it('names king steps 帅五进一 and 帅五平六', () => {
    expect(xiangqiMoveName(position('e0:Rk'), 'e0', 'e1')).toBe('帅五进一')
    expect(xiangqiMoveName(position('e1:Rk'), 'e1', 'd1')).toBe('帅五平六')
  })

  it('labels tandem cannons on one file 前/后 and drops the file number', () => {
    const cannons = position('e2:Rc', 'e5:Rc')
    // 前 is the piece nearer the opponent — the higher rank for red.
    expect(xiangqiMoveName(cannons, 'e5', 'e6')).toBe('前炮进一')
    expect(xiangqiMoveName(cannons, 'e2', 'e1')).toBe('后炮退一')
  })

  it('labels three tandem pawns 前/中/后', () => {
    const pawns = position('e4:Rp', 'e5:Rp', 'e6:Rp')
    // A red pawn past the river may step sideways; the middle one moves here.
    expect(xiangqiMoveName(pawns, 'e5', 'd5')).toBe('中兵平六')
  })

  it('replaces the pawn name with its file when two files both carry doubled pawns', () => {
    const pawns = position('c4:Rp', 'c5:Rp', 'e4:Rp', 'e5:Rp')
    expect(xiangqiMoveName(pawns, 'c5', 'c6')).toBe('前七进一')
  })

  it('keeps the plain file form for tandem advisors — 进/退 already disambiguates', () => {
    const advisors = position('d0:Ra', 'd2:Ra')
    expect(xiangqiMoveName(advisors, 'd0', 'e1')).toBe('仕六进五')
    expect(xiangqiMoveName(advisors, 'd2', 'e1')).toBe('仕六退五')
  })
})
