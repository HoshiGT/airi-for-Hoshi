import type { Color, Move, PieceSymbol, Square } from 'chess.js'

import type { BoardPiece, LegalMove, PlacedPiece, Side } from '../shared/types'
import type { RulesAdapter } from './types'

import { Chess } from 'chess.js'

const COLS = 8
const ROWS = 8

/** chess.js colour (`w`/`b`) to the order-based {@link Side}. White moves first. */
function toSide(color: Color): Side {
  return color === 'w' ? 'first' : 'second'
}

/** Grid cell to algebraic square, with `row = 0` at the top (rank 8). */
function squareAt(col: number, row: number): string {
  return `${String.fromCharCode(97 + col)}${ROWS - row}`
}

function toLegalMove(move: Move): LegalMove {
  return {
    from: move.from,
    to: move.to,
    // UCI appends the promotion piece letter, matching what the engine emits.
    uci: `${move.from}${move.to}${move.promotion ?? ''}`,
    san: move.san,
    promotion: move.promotion,
  }
}

/**
 * Rules adapter backed by chess.js for international chess.
 *
 * chess.js is synchronous, so this is created directly; the async
 * {@link createRules} factory wraps it to share a signature with xiangqi.
 */
export function createChessRules(fen?: string): RulesAdapter {
  const chess = new Chess(fen)

  function legalMovesFrom(square: string): LegalMove[] {
    return chess.moves({ square: square as Square, verbose: true }).map(toLegalMove)
  }

  return {
    variant: 'chess',
    cols: COLS,
    rows: ROWS,
    squareAt,
    fen: () => chess.fen(),
    setFen: fen => chess.load(fen),
    reset: () => chess.reset(),
    turn: () => toSide(chess.turn()),
    legalMoves: () => chess.moves({ verbose: true }).map(toLegalMove),
    legalMovesFrom,
    move(input) {
      const request = typeof input === 'string'
        ? { from: input.slice(0, 2), to: input.slice(2, 4), promotion: input.slice(4) || undefined }
        : input

      // chess.js requires an explicit promotion piece; default underspecified
      // pawn promotions to a queen so UCI moves and simple UI clicks both work.
      const candidate = legalMovesFrom(request.from).find(move =>
        move.to === request.to
        && (request.promotion === undefined || move.promotion === request.promotion),
      )
      if (!candidate) {
        return null
      }

      try {
        const applied = chess.move({
          from: candidate.from,
          to: candidate.to,
          promotion: candidate.promotion,
        })
        return toLegalMove(applied)
      }
      catch {
        // chess.js throws on illegal input; we already validated, so this only
        // guards against races and is reported to the caller as a rejected move.
        return null
      }
    },
    pieces() {
      const placed: PlacedPiece[] = []
      for (const rank of chess.board()) {
        for (const cell of rank) {
          if (cell) {
            placed.push({ square: cell.square, piece: { side: toSide(cell.color), role: cell.type } })
          }
        }
      }
      return placed
    },
    pieceAt(square) {
      const cell = chess.get(square as Square) as { type: PieceSymbol, color: Color } | undefined
      if (!cell) {
        return null
      }
      return { side: toSide(cell.color), role: cell.type } satisfies BoardPiece
    },
    isCheck: () => chess.isCheck(),
    isGameOver: () => chess.isGameOver(),
    result() {
      if (!chess.isGameOver()) {
        return '*'
      }
      if (chess.isCheckmate()) {
        // The side to move has been mated, so the other side won.
        return chess.turn() === 'w' ? '0-1' : '1-0'
      }
      return '1/2-1/2'
    },
    dispose() {},
  }
}
