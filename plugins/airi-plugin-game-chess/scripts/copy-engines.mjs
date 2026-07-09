// Copies the prebuilt WebAssembly engine artifacts out of node_modules into
// `public/engines/<variant>` so Vite serves them next to the iframe board UI.
//
// Why copy instead of bundling:
// - Emscripten glue scripts locate their sibling `.wasm` via a relative URL at
//   runtime; keeping `<name>.js` and `<name>.wasm` together preserves that.
// - The artifacts are large (7MB+ each) and must not be inlined into the JS bundle.
//
// The copied files are git-ignored (see .gitignore) and regenerated on every
// `dev:ui` / `build`, so the engine version always follows the installed package.

import { cp, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

/** Resolves an installed package's root directory via its package.json. */
function packageRoot(packageName) {
  return dirname(require.resolve(`${packageName}/package.json`))
}

/**
 * Engine artifacts per variant.
 *
 * Chess uses the single-threaded "lite" Stockfish 18 build: it runs in any iframe
 * without cross-origin isolation (no SharedArrayBuffer required), unlike the
 * multi-threaded builds that need COOP/COEP headers the asset server does not set.
 *
 * Xiangqi uses Fairy-Stockfish. Its worker script is only used when `Threads > 1`;
 * the board engine keeps `Threads = 1`, so it also runs without isolation.
 */
const engines = [
  {
    variant: 'chess',
    root: packageRoot('stockfish'),
    files: [
      'bin/stockfish-18-lite-single.js',
      'bin/stockfish-18-lite-single.wasm',
    ],
  },
  {
    variant: 'xiangqi',
    root: packageRoot('fairy-stockfish-nnue.wasm'),
    files: [
      'stockfish.js',
      'stockfish.wasm',
      'stockfish.worker.js',
    ],
  },
]

const publicEnginesDir = resolve(import.meta.dirname, '..', 'public', 'engines')

for (const engine of engines) {
  const outDir = join(publicEnginesDir, engine.variant)
  await mkdir(outDir, { recursive: true })

  for (const file of engine.files) {
    // Flatten any leading directory (e.g. `bin/`) so the served URL is
    // `engines/<variant>/<basename>` regardless of the source layout.
    const basename = file.slice(file.lastIndexOf('/') + 1)
    await cp(join(engine.root, file), join(outDir, basename))
  }
}

console.info('[airi-plugin-game-chess] copied engine artifacts into public/engines')
