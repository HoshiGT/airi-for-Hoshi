import type { Ref } from 'vue'

import type { BoardPiece, Side } from './shared'

import { ref, watch } from 'vue'

/**
 * One piece positioned on the animated overlay. `id` is stable across moves so
 * the same DOM node persists and its `transform` (driven by `col`/`row`) can be
 * transitioned — that is what makes a piece *slide* instead of teleport.
 */
export interface LayoutPiece {
  /** Stable identity that survives a move; a captured piece's id is retired. */
  id: number
  square: string
  /** Zero-based grid column / row, used to position the overlay element. */
  col: number
  row: number
  side: Side
  /** Lowercase role letter (chess: p n b r q k; xiangqi: p a b r c n k). */
  role: string
}

/** A move touches at most two source squares (a normal move, a capture's mover, or castling's king+rook). */
const MAX_MOVE_VACATED = 2

/**
 * Reconciles the square→piece map into a stable list of overlay pieces.
 *
 * On every position change it diffs the previous render against the new one:
 * squares whose occupant is unchanged keep their piece (and id); the remaining
 * `vacated` (left) and `appeared` (arrived) squares are matched so the piece
 * that *moved* keeps its id and animates to the new square. Matching prefers the
 * same side+role, then the same side (promotion changes role), so castling,
 * captures, en passant and promotion all resolve to the right slides while the
 * captured piece falls out of the list (and fades via the overlay transition).
 *
 * A wholesale change (variant switch, new game, first render) vacates/appears
 * more squares than any single move can, so it bypasses matching: every piece
 * gets a fresh id and the overlay cross-fades instead of sliding nonsensically.
 *
 * @param pieces   Current square→piece map (recomputed from FEN each move).
 * @param cols     Board column count for the active variant.
 * @param rows     Board row count for the active variant.
 * @param squareAt Maps grid `(col, row)` to the variant's square label.
 */
export function usePieceLayout(
  pieces: Ref<Record<string, BoardPiece>>,
  cols: Ref<number>,
  rows: Ref<number>,
  squareAt: Ref<(col: number, row: number) => string>,
): Ref<LayoutPiece[]> {
  const layout = ref<LayoutPiece[]>([])
  let nextId = 1

  function positionsOf(): Map<string, { col: number, row: number }> {
    const map = new Map<string, { col: number, row: number }>()
    for (let row = 0; row < rows.value; row++) {
      for (let col = 0; col < cols.value; col++) {
        map.set(squareAt.value(col, row), { col, row })
      }
    }
    return map
  }

  watch([pieces, cols, rows, squareAt], () => {
    const positions = positionsOf()
    const next = pieces.value
    const prev = layout.value

    const prevBySquare = new Map(prev.map(piece => [piece.square, piece]))

    const kept: LayoutPiece[] = []
    const vacated: LayoutPiece[] = []
    const appeared: string[] = []

    // Squares whose occupant is byte-identical keep their piece untouched.
    for (const piece of prev) {
      const still = next[piece.square]
      if (still && still.side === piece.side && still.role === piece.role) {
        kept.push(piece)
      }
      else {
        vacated.push(piece)
      }
    }
    for (const square of Object.keys(next)) {
      const before = prevBySquare.get(square)
      const here = next[square]
      if (!before || before.side !== here.side || before.role !== here.role) {
        appeared.push(square)
      }
    }

    const isMove = vacated.length <= MAX_MOVE_VACATED && appeared.length <= MAX_MOVE_VACATED
    const pool = [...vacated]

    const arrived: LayoutPiece[] = appeared.map((square) => {
      const piece = next[square]
      const pos = positions.get(square) ?? { col: 0, row: 0 }

      // Reuse the id of the piece that moved here so it keeps its DOM node and
      // slides; an unmatched arrival (or any wholesale change) starts fresh.
      let matchIndex = -1
      if (isMove) {
        matchIndex = pool.findIndex(candidate => candidate.side === piece.side && candidate.role === piece.role)
        if (matchIndex === -1) {
          matchIndex = pool.findIndex(candidate => candidate.side === piece.side)
        }
      }
      const id = matchIndex === -1 ? nextId++ : pool.splice(matchIndex, 1)[0].id

      return { id, square, col: pos.col, row: pos.row, side: piece.side, role: piece.role }
    })

    layout.value = [...kept, ...arrived]
  }, { immediate: true, deep: true })

  return layout
}
