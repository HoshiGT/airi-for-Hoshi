import { defineConfig } from 'tsdown'

// NOTICE:
// Only the Node-side extension entrypoint is built here. The iframe board UI is
// a separate browser bundle produced by `vite build` (see vite.config.ts) and is
// emitted to `dist/ui`. Keeping the two build outputs in one `dist` lets the
// extension host serve `./ui/index.html` next to `./index.mjs`.
export default defineConfig([
  {
    entry: ['./src/index.ts'],
    format: ['esm'],
    dts: true,
    // The iframe UI, browser engines and rules adapters must not be pulled into
    // the Node entrypoint bundle; they are only referenced from the UI build.
    external: ['chess.js', 'ffish', 'stockfish', 'fairy-stockfish-nnue.wasm'],
  },
])
