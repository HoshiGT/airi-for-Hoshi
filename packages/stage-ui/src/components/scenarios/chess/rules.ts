import type { BoardPiece, LegalMove, PlacedPiece, Side, Variant } from './shared'

import { ffishModule, uciFromFfish, uciToFfish } from './ffish-module'
import { xiangqiMoveName } from './xiangqi-notation'

/** Board geometry per variant. `rows`/`cols` count ranks/files. */
const GEOMETRY: Record<Variant, { cols: number, rows: number }> = {
  chess: { cols: 8, rows: 8 },
  xiangqi: { cols: 9, rows: 10 },
}

/**
 * Uniform rules surface over ffish (Fairy-Stockfish) for both variants.
 *
 * The board UI is variant-agnostic: it addresses cells by `(col, row)` with
 * `row = 0` at the top, and {@link RulesAdapter.squareAt} maps that to the
 * variant's square label (`e2` for chess, `e0` for xiangqi). Every square and
 * UCI crossing this surface uses that same convention — xiangqi ranks 0-based
 * (a0..i9, as Pikafish/UCCI) — while ffish's own 1-based xiangqi labels are
 * translated at each board call (see `uciFromFfish`/`uciToFfish`).
 */
export interface RulesAdapter {
  readonly variant: Variant
  readonly cols: number
  readonly rows: number
  squareAt: (col: number, row: number) => string
  fen: () => string
  setFen: (fen: string) => void
  reset: () => void
  turn: () => Side
  legalMoves: () => LegalMove[]
  legalMovesFrom: (square: string) => LegalMove[]
  move: (input: string | { from: string, to: string, promotion?: string }) => LegalMove | null
  pieces: () => PlacedPiece[]
  pieceAt: (square: string) => BoardPiece | null
  isCheck: () => boolean
  isGameOver: () => boolean
  result: () => string
  dispose: () => void
}

/** ffish exposes the side to move as a boolean; `true` is White, i.e. Red/first. */
function toSide(white: boolean): Side {
  return white ? 'first' : 'second'
}

/** FEN piece letter to a normalized piece; uppercase is the first (White/Red) side. */
function toPiece(letter: string): BoardPiece {
  return { side: letter === letter.toUpperCase() ? 'first' : 'second', role: letter.toLowerCase() }
}

/**
 * Creates a rules adapter for either variant. Async because the ffish WASM
 * module must load first; reuse the adapter for the whole match and call
 * {@link RulesAdapter.dispose} to free the native board.
 */
export async function createRules(variant: Variant, fen?: string): Promise<RulesAdapter> {
  const ffish = await ffishModule()
  const { cols, rows } = GEOMETRY[variant]
  const board = fen ? new ffish.Board(variant, fen) : new ffish.Board(variant)

  // Square labels run with `row = 0` at the top, so the rank number decreases
  // as rows increase (rank 8→1 for chess, rank 9→0 for xiangqi).
  const squareAt = (col: number, row: number) => `${String.fromCharCode(97 + col)}${rows - 1 - row + (variant === 'chess' ? 1 : 0)}`

  function uciOf(input: string | { from: string, to: string, promotion?: string }): string {
    return typeof input === 'string' ? input : `${input.from}${input.to}${input.promotion ?? ''}`
  }

  // `uci` is UI convention: post-normalization every square is exactly two
  // characters, so fixed slicing is safe (ffish's raw "b3b10" would not be).
  function toLegalMove(uci: string): LegalMove {
    const from = uci.slice(0, 2)
    const to = uci.slice(2, 4)
    // Chess keeps ffish SAN; xiangqi uses Chinese column notation — ffish's SAN
    // would leak its 1-based ranks (a pawn landing on UI c4 reads "Pc5").
    const san = variant === 'xiangqi'
      ? xiangqiMoveName(parsePieces(), from, to)
      : board.sanMove(uciToFfish(variant, uci))
    return { from, to, uci, san, promotion: uci.slice(4) || undefined }
  }

  // ffish emits xiangqi UCIs with 1-based ranks; normalize to this adapter's
  // 0-based surface at the single listing point, and translate back right
  // before each board call (sanMove/push). The prefix matching in
  // legalMovesFrom and the move() validation below rely on this — raw ffish
  // UCIs never match a UI square, which made xiangqi unplayable for the human.
  function legalMoveUcis(): string[] {
    const moves = board.legalMoves().trim()
    return moves ? moves.split(/\s+/).map(uci => uciFromFfish(variant, uci)) : []
  }

  function parsePieces(): PlacedPiece[] {
    const placement = board.fen().trim().split(/\s+/)[0] ?? ''
    const placed: PlacedPiece[] = []
    placement.split('/').forEach((rankField, rankIndex) => {
      let col = 0
      for (const symbol of rankField) {
        if (symbol >= '1' && symbol <= '9') {
          col += Number(symbol)
          continue
        }
        placed.push({ square: squareAt(col, rankIndex), piece: toPiece(symbol) })
        col += 1
      }
    })
    return placed
  }

  return {
    variant,
    cols,
    rows,
    squareAt,
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
      return board.push(uciToFfish(variant, uci)) ? move : null
    },
    pieces: parsePieces,
    pieceAt: square => parsePieces().find(placed => placed.square === square)?.piece ?? null,
    isCheck: () => board.isCheck(),
    isGameOver: () => board.isGameOver(),
    result: () => (board.isGameOver() ? board.result() : '*'),
    dispose: () => board.delete(),
  }
}
