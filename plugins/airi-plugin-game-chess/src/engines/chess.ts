import type { EngineAdapter } from './index'
import type { UciTransport } from './uci'

import { analyzeViaUci, uciHandshake } from './uci'

// Single-threaded Stockfish 18 "lite" build: it runs inside the extension iframe
// without cross-origin isolation. The file is copied to `public/engines/chess`
// by scripts/copy-engines.mjs and served at the iframe-relative path below.
const ENGINE_PATH = 'engines/chess/stockfish-18-lite-single.js'

/**
 * Creates the international-chess engine adapter backed by Stockfish running in a
 * dedicated Web Worker. The single-file build is loaded directly as the worker
 * script and locates its sibling `.wasm` relative to itself.
 */
export async function createChessEngine(): Promise<EngineAdapter> {
  const worker = new Worker(new URL(ENGINE_PATH, document.baseURI))
  const listeners = new Set<(line: string) => void>()

  worker.addEventListener('message', (event: MessageEvent) => {
    const line = typeof event.data === 'string' ? event.data : String(event.data)
    for (const listener of listeners) {
      listener(line)
    }
  })

  const transport: UciTransport = {
    send: command => worker.postMessage(command),
    onLine: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => worker.terminate(),
  }

  await uciHandshake(transport)

  return {
    analyze: (fen, options) => analyzeViaUci(transport, fen, options),
    dispose: () => transport.dispose(),
  }
}
