import type { FairyStockfish } from 'ffish-es6'

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import initFfish from 'ffish-es6'

import { beforeAll, describe, expect, it } from 'vitest'

import { uciFromFfish, uciToFfish } from './ffish-module'

// ROOT CAUSE:
//
// The in-app board never loaded ("引擎/棋盘加载不出来"). `ffish-module.ts`
// imported the legacy `ffish` npm package and called its default export as a
// factory: `initFfish({ locateFile })`.
//
// `ffish@0.7.9` is a non-MODULARIZE Emscripten build: it only runs
// `module.exports = Module` inside its Node branch, so its default export is a
// plain object (the Module object in Node, undefined-ish in the browser) — not
// a callable factory. `initFfish(...)` therefore threw "initFfish is not a
// function" before any board could be created. The package ships a `ffish.d.ts`
// that advertises the es6 factory shape, so typecheck passed while runtime
// always failed.
//
// We fixed this by switching the dependency to `ffish-es6@0.7.9` — the same
// Fairy-Stockfish upstream built with MODULARIZE=EXPORT_ES6, whose
// `export default Module` IS the `(opts) => Promise<FairyStockfish>` factory the
// code already called.
//
// This test loads the real ffish-es6 WASM through Node's filesystem and asserts
// the move generator works for both variants. The faithful in-app path (Vite
// `?url` + browser fetch through `rules.ts`) is covered by
// `rules.browser.test.ts`; this node test is the deterministic guard that the
// dependency itself is the callable es6 build. Reverting to `ffish` makes
// `typeof initFfish` 'object' and this whole suite fails.

// ffish-es6's Emscripten ESM build calls `fetch()` in `instantiateAsync` even
// under Node (Node ≥18 exposes a global `fetch`), and that fetch rejects a bare
// filesystem path. Node's fetch does accept `data:` URLs, so we hand `locateFile`
// a base64 data URL of the wasm bytes — staying within the typed `locateFile`
// option instead of the untyped `wasmBinary` Emscripten field.
const require = createRequire(import.meta.url)
const wasmDataUrl = `data:application/wasm;base64,${readFileSync(require.resolve('ffish-es6/ffish.wasm')).toString('base64')}`

describe('ffish-es6 engine (node WASM load)', () => {
  let ffish: FairyStockfish

  beforeAll(async () => {
    expect(typeof initFfish).toBe('function')
    ffish = await initFfish({ locateFile: file => (file.endsWith('.wasm') ? wasmDataUrl : file) })
  })

  it('exposes the Board constructor once the WASM runtime is ready', () => {
    expect(typeof ffish.Board).toBe('function')
  })

  it('generates the 20 legal opening moves for chess', () => {
    const board = new ffish.Board('chess')
    expect(board.legalMoves().trim().split(/\s+/)).toHaveLength(20)
    expect(board.turn()).toBe(true)
    board.delete()
  })

  it('generates the 44 legal opening moves for xiangqi', () => {
    const board = new ffish.Board('xiangqi')
    expect(board.legalMoves().trim().split(/\s+/)).toHaveLength(44)
    expect(board.turn()).toBe(true)
    board.delete()
  })

  // ROOT CAUSE:
  //
  // In-app xiangqi was unplayable for the human: clicking a red pawn (UI square
  // c3) showed zero legal-move hints and move() rejected every input.
  //
  // ffish emits xiangqi move UCIs with 1-based ranks (a1..i10, two-digit "10"),
  // while rules.ts `squareAt` labels cells 0-based (a0..i9 — the Pikafish/UCCI
  // convention the rest of the scenario uses). `legalMovesFrom(square)` filters
  // by `uci.startsWith(square)`, so no UI square ever matched a raw ffish UCI
  // (the c3 pawn is "c4" to ffish); the same mismatch made move() validation
  // reject the server engine's 0-based Pikafish moves.
  //
  // We fixed this by normalizing every ffish-emitted UCI to the 0-based surface
  // (uciFromFfish) at the rules/engine listing points and translating back with
  // uciToFfish right before each ffish board call (sanMove/push).
  describe('xiangqi UCI rank convention (regression)', () => {
    it('ffish emits 1-based ranks and normalization makes them 0-based, two chars per square', () => {
      const board = new ffish.Board('xiangqi')
      const raw = board.legalMoves().trim().split(/\s+/)
      // Raw ffish list is 1-based: the b-file cannon sits on b3 and reaches b10.
      expect(raw).toContain('b3b10')
      expect(raw.some(uci => /^[a-i]0/.test(uci))).toBe(false)

      const normalized = raw.map(uci => uciFromFfish('xiangqi', uci))
      for (const uci of normalized) {
        expect(uci).toMatch(/^[a-i]\d[a-i]\d$/)
      }
      // The red c-pawn push now prefix-matches its UI square c3.
      expect(normalized).toContain('c3c4')
      // A UI-convention move round-trips into a playable ffish move.
      expect(board.push(uciToFfish('xiangqi', 'c3c4'))).toBe(true)
      board.delete()
    })

    it('passes chess UCIs through unchanged in both directions', () => {
      expect(uciFromFfish('chess', 'e2e4')).toBe('e2e4')
      expect(uciToFfish('chess', 'e7e8q')).toBe('e7e8q')
    })
  })
})
