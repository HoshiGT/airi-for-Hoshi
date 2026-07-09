import type { EngineAdapter } from './index'
import type { UciTransport } from './uci'

import { analyzeViaUci, uciHandshake } from './uci'

/** Minimal surface of the Emscripten Fairy-Stockfish module instance. */
interface FairyEngine {
  postMessage: (command: string) => void
  addMessageListener: (listener: (line: string) => void) => void
}

type FairyFactory = (options?: { locateFile?: (path: string) => string }) => Promise<FairyEngine>

declare global {
  interface Window {
    /** Set by the classic Fairy-Stockfish engine script once it loads. */
    Stockfish?: FairyFactory
  }
}

// Fairy-Stockfish artifacts copied to `public/engines/xiangqi` by
// scripts/copy-engines.mjs and served at this iframe-relative directory.
const ENGINE_DIR = 'engines/xiangqi/'

/**
 * Loads the Fairy-Stockfish factory by injecting its classic script once.
 *
 * The engine is a UMD bundle: loaded as a classic `<script>`, its top-level
 * `var Stockfish` becomes `window.Stockfish`. A module/`import()` load would not
 * set that global, so script injection is the reliable path here.
 */
async function loadFairyFactory(): Promise<FairyFactory> {
  if (window.Stockfish) {
    return window.Stockfish
  }

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = new URL(`${ENGINE_DIR}stockfish.js`, document.baseURI).href
    script.addEventListener('load', () => resolve())
    script.addEventListener('error', () => reject(new Error('Failed to load Fairy-Stockfish engine script.')))
    document.head.appendChild(script)
  })

  if (!window.Stockfish) {
    throw new Error('Fairy-Stockfish engine global was not defined after loading.')
  }
  return window.Stockfish
}

/**
 * Creates the xiangqi engine adapter backed by Fairy-Stockfish.
 *
 * The engine runs on the iframe thread with `Threads = 1`, which avoids the
 * pthread worker and therefore the SharedArrayBuffer / cross-origin isolation
 * requirement the asset server does not satisfy.
 */
export async function createXiangqiEngine(): Promise<EngineAdapter> {
  const factory = await loadFairyFactory()
  const engine = await factory({
    locateFile: (path) => {
      const file = path.endsWith('.wasm') ? 'stockfish.wasm' : path
      return new URL(`${ENGINE_DIR}${file}`, document.baseURI).href
    },
  })

  const listeners = new Set<(line: string) => void>()
  engine.addMessageListener((line) => {
    for (const listener of listeners) {
      listener(line)
    }
  })

  const transport: UciTransport = {
    send: command => engine.postMessage(command),
    onLine: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => engine.postMessage('quit'),
  }

  await uciHandshake(transport, (send) => {
    send('setoption name Threads value 1')
    send('setoption name UCI_Variant value xiangqi')
  })

  return {
    analyze: (fen, options) => analyzeViaUci(transport, fen, options),
    dispose: () => transport.dispose(),
  }
}
