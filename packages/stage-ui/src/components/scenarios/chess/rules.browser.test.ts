import { describe, expect, it } from 'vitest'

import { createRules } from './rules'

// ROOT CAUSE:
//
// The in-app board never loaded ("引擎/棋盘加载不出来"). `ffish-module.ts`
// imported the legacy `ffish` npm package and called its default export as a
// factory: `initFfish({ locateFile })`.
//
// `ffish@0.7.9` is a non-MODULARIZE Emscripten build. It only runs
// `module.exports = Module` inside its Node branch, so in the browser its
// default export is a plain object (and even in Node it is the Module object,
// not a function). Calling it threw "initFfish is not a function" before any
// board could be created. The shipped `ffish.d.ts` falsely advertises the
// es6 factory shape, so typecheck passed while runtime always failed.
//
// We fixed this by switching the dependency to `ffish-es6@0.7.9` — the same
// Fairy-Stockfish upstream built with MODULARIZE=EXPORT_ES6, whose
// `export default Module` IS the `(opts) => Promise<FairyStockfish>` factory
// this code already called. This test exercises the full load path through
// Vite's `?url` wasm resolution and would fail (rejected promise) on the old
// `ffish` import.
describe('createRules (ffish-es6 WASM load path)', () => {
  it('loads the chess rules adapter and reports the 20 legal opening moves', async () => {
    const rules = await createRules('chess')
    expect(rules.variant).toBe('chess')
    expect(rules.legalMoves()).toHaveLength(20)
    expect(rules.turn()).toBe('first')
    rules.dispose()
  })

  it('loads the xiangqi rules adapter and reports the 44 legal opening moves', async () => {
    const rules = await createRules('xiangqi')
    expect(rules.variant).toBe('xiangqi')
    expect(rules.legalMoves()).toHaveLength(44)
    expect(rules.turn()).toBe('first')
    rules.dispose()
  })
})

// ROOT CAUSE: ffish emits xiangqi UCIs with 1-based ranks (a1..i10) while this
// adapter's surface — squareAt, Pikafish results, the coach — is 0-based
// (a0..i9), so legalMovesFrom/move never matched a UI square and the human
// could not move at all. Full analysis lives in ffish-engine.test.ts; these
// cases exercise the fix through the real adapter surface.
describe('xiangqi human moves on the 0-based surface (regression)', () => {
  it('finds legal moves for the red c-pawn at its UI square c3', async () => {
    const rules = await createRules('xiangqi')
    expect(rules.pieceAt('c3')).toEqual({ side: 'first', role: 'p' })
    expect(rules.legalMovesFrom('c3').map(move => move.uci)).toContain('c3c4')
    rules.dispose()
  })

  it('accepts a UI-convention move and mirrors the piece to the target square', async () => {
    const rules = await createRules('xiangqi')
    const move = rules.move({ from: 'c3', to: 'c4' })
    expect(move?.uci).toBe('c3c4')
    // Xiangqi moves are named in Chinese column notation, not ffish SAN.
    expect(move?.san).toBe('兵七进一')
    expect(rules.pieceAt('c4')).toEqual({ side: 'first', role: 'p' })
    expect(rules.pieceAt('c3')).toBeNull()
    expect(rules.turn()).toBe('second')
    rules.dispose()
  })

  it('reports every xiangqi legal move with 0-based two-character squares', async () => {
    const rules = await createRules('xiangqi')
    for (const move of rules.legalMoves()) {
      expect(move.uci).toMatch(/^[a-i]\d[a-i]\d$/)
      expect(move.from).toBe(move.uci.slice(0, 2))
      expect(move.to).toBe(move.uci.slice(2, 4))
    }
    rules.dispose()
  })
})
