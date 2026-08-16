import type { ModuleOptions } from 'ffish-es6'

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
// Inlined as a data URI so the bytes travel inside the JS bundle instead of
// being fetched at runtime. ffish is single-threaded (no SharedArrayBuffer),
// so it runs without cross-origin isolation — unlike the pthread
// Fairy-Stockfish engine build.
import ffishWasmInline from 'ffish-es6/ffish.wasm?inline'

// NOTICE:
// The ffish Emscripten glue loads its `.wasm` with `fetch(wasmBinaryFile)` and
// that promise chain has no catch handler. In the production Electron renderer
// the app runs over `file://`, where fetch rejects for the file scheme; the
// "wasm-instantiate" run dependency added by createWasm() is then never
// released, so `Module.ready` never resolves and `await ffishModule()` hangs
// forever with no error (blank board). Dev mode and stage-web use http(s), so
// only the packaged desktop app was affected.
// Passing the bytes as `wasmBinary` bypasses fetch entirely: the glue's
// getBinaryPromise() resolves `wasmBinary` directly instead of fetching.
// Verified against ffish-es6@0.7.9 ffish.js (getBinaryPromise / instantiateAsync).
// Removal condition: only if the desktop renderer stops serving over file://.
const FFISH_WASM_BINARY = decodeInlineWasm(ffishWasmInline)

/**
 * Decodes a Vite `?inline` data URI (base64) into wasm bytes.
 *
 * Before:
 * - "data:application/wasm;base64,AGFzbQEAAA..."
 *
 * After:
 * - ArrayBuffer containing the decoded bytes
 */
function decodeInlineWasm(dataUri: string): ArrayBuffer {
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i)

  return bytes.buffer
}

// One WASM module instance is shared by every board and the search engine;
// initializing it is the expensive step, so it is created once and reused.
let ffishModulePromise: ReturnType<typeof initFfish> | undefined

// The shipped ffish.d.ts omits `wasmBinary`, the Emscripten option that skips
// the glue's runtime fetch (untyped but part of the actual init contract);
// declared as an intersection here instead of a module augmentation, which
// would shadow the package's own type file under bundler resolution.
type FfishInitOptions = ModuleOptions & { wasmBinary?: ArrayBuffer | Uint8Array }

/** Returns the shared ffish module, initializing the WASM runtime on first use. */
export function ffishModule(): ReturnType<typeof initFfish> {
  const options: FfishInitOptions = { wasmBinary: FFISH_WASM_BINARY }
  ffishModulePromise ??= initFfish(options)
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
