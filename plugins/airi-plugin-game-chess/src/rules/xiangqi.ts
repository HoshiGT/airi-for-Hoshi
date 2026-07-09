import type { LegalMove, Side } from '../shared/types'
import type { RulesAdapter } from './types'

// NOTICE:
// Use `ffish-es6`, not `ffish`. Same Fairy-Stockfish 0.7.9 upstream, different
// Emscripten build: `ffish` is the legacy non-MODULARIZE build whose default
// export is a plain object in the browser (it assigns `module.exports = Module`
// only in its Node branch), so calling it as `initFfish(...)` throws
// "initFfish is not a function". `ffish-es6` is the MODULARIZE=EXPORT_ES6 build
// whose `export default Module` is the `(opts) => Promise<FairyStockfish>` factory
// used here. Both ship the same `ffish.d.ts`, so a wrong `ffish` import typechecks
// but only fails at runtime.
import initFfish from 'ffish-es6'
// The ffish glue locates its sibling `.wasm` at runtime; Vite rewrites this to
// the emitted asset URL and the test runner resolves it from node_modules.
import ffishWasmUrl from 'ffish-es6/ffish.wasm?url'

import {
  parseXiangqiFenPieces,
  XIANGQI_COLS,
  XIANGQI_ROWS,
  xiangqiSquareAt,
} from './xiangqi-board'

/** ffish exposes the side to move as a boolean; `true` is White, i.e. Red/first. */
function toSide(white: boolean): Side {
  return white ? 'first' : 'second'
}

function uciOf(input: string | { from: string, to: string }): string {
  return typeof input === 'string' ? input : `${input.from}${input.to}`
}

/**
 * Creates a xiangqi rules adapter backed by the ffish (Fairy-Stockfish) WASM
 * library. Initialization is async because the WebAssembly module must load
 * first; callers should reuse the returned adapter for the whole match and call
 * {@link RulesAdapter.dispose} to free the native board.
 */
export async function createXiangqiRules(fen?: string): Promise<RulesAdapter> {
  const ffish = await initFfish({ locateFile: file => (file.endsWith('.wasm') ? ffishWasmUrl : file) })
  const board = fen ? new ffish.Board('xiangqi', fen) : new ffish.Board('xiangqi')

  function toLegalMove(uci: string): LegalMove {
    return {
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      uci,
      san: board.sanMove(uci),
    }
  }

  function legalMoveUcis(): string[] {
    const moves = board.legalMoves().trim()
    return moves ? moves.split(/\s+/) : []
  }

  return {
    variant: 'xiangqi',
    cols: XIANGQI_COLS,
    rows: XIANGQI_ROWS,
    squareAt: xiangqiSquareAt,
    fen: () => board.fen(),
    setFen: fen => board.setFen(fen),
    reset: () => board.reset(),
    turn: () => toSide(board.turn()),
    legalMoves: () => legalMoveUcis().map(toLegalMove),
    legalMovesFrom: square => legalMoveUcis().filter(uci => uci.startsWith(square)).map(toLegalMove),
    move(input) {
      const uci = uciOf(input)
      if (!legalMoveUcis().includes(uci)) {
        return null
      }
      // Capture SAN against the pre-move position before mutating the board.
      const move = toLegalMove(uci)
      return board.push(uci) ? move : null
    },
    pieces: () => parseXiangqiFenPieces(board.fen()),
    pieceAt(square) {
      return parseXiangqiFenPieces(board.fen()).find(placed => placed.square === square)?.piece ?? null
    },
    isCheck: () => board.isCheck(),
    isGameOver: () => board.isGameOver(),
    result: () => (board.isGameOver() ? board.result() : '*'),
    dispose: () => board.delete(),
  }
}
