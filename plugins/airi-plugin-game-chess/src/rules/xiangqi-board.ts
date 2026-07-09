import type { PlacedPiece, Side } from '../shared/types'

/**
 * Pure xiangqi board helpers, kept free of the ffish WASM import so they can be
 * unit-tested in Node and reused for rendering without booting the engine.
 */

/** Files a–i. */
export const XIANGQI_COLS = 9
/** Ranks 0–9. */
export const XIANGQI_ROWS = 10

/**
 * Grid cell to xiangqi square label, with `row = 0` at the top of the board.
 *
 * Before:
 * - `(col: 4, row: 0)`  // top edge, black's back rank
 *
 * After:
 * - `"e9"`
 */
export function xiangqiSquareAt(col: number, row: number): string {
  // The top FEN rank is rank 9; rows increase downward toward Red's rank 0.
  return `${String.fromCharCode(97 + col)}${XIANGQI_ROWS - 1 - row}`
}

/**
 * FEN piece letter to a normalized role. Uppercase letters are Red (the side
 * that moves first); lowercase are Black. Roles match {@link BoardPiece.role}:
 * `k` general, `a` advisor, `b` elephant, `n` horse, `r` chariot, `c` cannon,
 * `p` soldier.
 */
function toPiece(letter: string): { side: Side, role: string } {
  const side: Side = letter === letter.toUpperCase() ? 'first' : 'second'
  return { side, role: letter.toLowerCase() }
}

/**
 * Parses the placement field of a xiangqi FEN into placed pieces.
 *
 * Before:
 * - `"rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1"`
 *
 * After:
 * - `[{ square: "a9", piece: { side: "second", role: "r" } }, ...]`
 */
export function parseXiangqiFenPieces(fen: string): PlacedPiece[] {
  const placement = fen.trim().split(/\s+/)[0] ?? ''
  const ranks = placement.split('/')
  const placed: PlacedPiece[] = []

  ranks.forEach((rankField, rankIndex) => {
    let col = 0
    for (const symbol of rankField) {
      if (symbol >= '1' && symbol <= '9') {
        col += Number(symbol)
        continue
      }
      placed.push({ square: xiangqiSquareAt(col, rankIndex), piece: toPiece(symbol) })
      col += 1
    }
  })

  return placed
}

/** Side to move from a xiangqi FEN's active-colour field (`w` = Red/first). */
export function xiangqiSideToMove(fen: string): Side {
  return fen.trim().split(/\s+/)[1] === 'b' ? 'second' : 'first'
}
