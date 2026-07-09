import type { BoardPiece, LegalMove, PlacedPiece, Side, Variant } from '../shared/types'

/**
 * Uniform rules surface over chess.js (international chess) and ffish (xiangqi).
 *
 * The board UI is variant-agnostic: it only talks to this interface, so the same
 * grid/interaction code renders both games. Coordinate conventions:
 * - The grid is addressed by `(col, row)` with `row = 0` at the top of the board.
 * - {@link RulesAdapter.squareAt} converts a grid cell to the variant's square
 *   label (e.g. `e2` for chess, `e0` for xiangqi), which is what `from`/`to`
 *   on {@link LegalMove} use.
 */
export interface RulesAdapter {
  readonly variant: Variant
  /** Number of columns (files): 8 for chess, 9 for xiangqi. */
  readonly cols: number
  /** Number of rows (ranks): 8 for chess, 10 for xiangqi. */
  readonly rows: number

  /** Square label for a grid cell, with `row = 0` at the top of the board. */
  squareAt: (col: number, row: number) => string

  /** Current position in the variant's FEN dialect. */
  fen: () => string
  /** Loads a position from FEN. */
  setFen: (fen: string) => void
  /** Restores the starting position. */
  reset: () => void

  /** Side to move. */
  turn: () => Side

  /** All legal moves in the current position. */
  legalMoves: () => LegalMove[]
  /** Legal moves originating from one square; used to highlight destinations. */
  legalMovesFrom: (square: string) => LegalMove[]

  /**
   * Applies a move and advances the position.
   *
   * Accepts either a UCI string or an explicit from/to (with optional promotion).
   * Returns the applied {@link LegalMove}, or `null` when the move is illegal.
   */
  move: (input: string | { from: string, to: string, promotion?: string }) => LegalMove | null

  /** All pieces currently on the board, for rendering. */
  pieces: () => PlacedPiece[]
  /** The piece on one square, or `null` when empty. */
  pieceAt: (square: string) => BoardPiece | null

  /** Whether the side to move is in check. */
  isCheck: () => boolean
  /** Whether the game has ended (checkmate, stalemate, draw, variant end). */
  isGameOver: () => boolean
  /** Result token: `1-0`, `0-1`, `1/2-1/2`, or `*` while ongoing. */
  result: () => string

  /** Releases any native (WASM) resources held by the adapter. */
  dispose: () => void
}
