import type { Variant } from './shared'

// NOTICE:
// Use `ffish-es6`, not `ffish`. They are the same Fairy-Stockfish 0.7.9 upstream
// (ianfab/Fairy-Stockfish, tests/js) but different Emscripten builds: `ffish` is
// the legacy non-MODULARIZE build that only assigns `module.exports = Module`
// inside its Node branch and auto-loads the wasm on import, so its default export
// is a plain object (not a factory) in the browser. Calling it as `initFfish(...)`
// throws "initFfish is not a function" and the board never initializes. `ffish-es6`
// is the MODULARIZE=EXPORT_ES6 build whose `export default Module` is the
// `(opts) => Promise<FairyStockfish>` factory this file calls. The shipped
// `ffish.d.ts` describes the es6 factory shape for both packages, so a wrong
// `ffish` import still typechecks but fails only at runtime.
import initFfish from 'ffish-es6'
// The ffish glue locates its sibling `.wasm` at runtime; Vite rewrites this to
// the emitted asset URL, so no engine files need to be served separately. ffish
// is single-threaded (no SharedArrayBuffer), so it runs without cross-origin
// isolation — unlike the pthread Fairy-Stockfish engine build.
import ffishWasmUrl from 'ffish-es6/ffish.wasm?url'

// One WASM module instance is shared by every board and the search engine;
// initializing it is the expensive step, so it is created once and reused.
let ffishModulePromise: ReturnType<typeof initFfish> | undefined

/** Returns the shared ffish module, initializing the WASM runtime on first use. */
export function ffishModule(): ReturnType<typeof initFfish> {
  ffishModulePromise ??= initFfish({ locateFile: file => (file.endsWith('.wasm') ? ffishWasmUrl : file) })
  return ffishModulePromise
}

// NOTICE:
// ffish labels xiangqi squares with 1-based ranks (a1..i10 — note the two-digit
// "10"), while everything else in this scenario — `squareAt` in rules.ts, the
// Pikafish/UCCI results from the server engine, the coach's board description —
// uses 0-based ranks (a0..i9). Verified in node: `new ffish.Board('xiangqi')
// .legalMoves()` returns "a1a2 … b3b10 …" and never a rank 0. Without this
// translation, UI squares never prefix-match ffish move UCIs, which made
// xiangqi unplayable for the human. Chess ranks are 1-based on both sides, so
// chess UCIs pass through unchanged.

/** Shifts every rank number inside a move UCI by `delta`, e.g. "b3b10" + (-1) → "b2b9". */
function shiftUciRanks(uci: string, delta: number): string {
  return uci.replace(/([a-i])(\d{1,2})/g, (_, file: string, rank: string) => `${file}${Number(rank) + delta}`)
}

/**
 * Normalizes a ffish-emitted move UCI to the scenario's square convention.
 *
 * Before:
 * - "b3b10" (xiangqi, ffish 1-based ranks)
 *
 * After:
 * - "b2b9" (0-based ranks; every square becomes exactly two characters)
 */
export function uciFromFfish(variant: Variant, uci: string): string {
  return variant === 'xiangqi' ? shiftUciRanks(uci, -1) : uci
}

/** Inverse of {@link uciFromFfish}: prepares a UI-convention UCI for a ffish board call. */
export function uciToFfish(variant: Variant, uci: string): string {
  return variant === 'xiangqi' ? shiftUciRanks(uci, 1) : uci
}
