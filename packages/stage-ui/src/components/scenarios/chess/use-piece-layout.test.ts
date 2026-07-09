import type { Ref } from 'vue'

import type { BoardPiece } from './shared'
import type { LayoutPiece } from './use-piece-layout'

import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'

import { usePieceLayout } from './use-piece-layout'

// Standard chess mapping: row 0 is the top (rank 8), so a1 is col 0 / row 7.
function chessSquareAt(col: number, row: number): string {
  return `${String.fromCharCode(97 + col)}${8 - row}`
}

const W = (role: string): BoardPiece => ({ side: 'first', role })
const B = (role: string): BoardPiece => ({ side: 'second', role })

function setup(initial: Record<string, BoardPiece>) {
  const pieces = ref<Record<string, BoardPiece>>(initial)
  const layout = usePieceLayout(pieces, ref(8), ref(8), ref(chessSquareAt))
  return { pieces, layout }
}

function idAt(layout: Ref<LayoutPiece[]>, square: string): number | undefined {
  return layout.value.find(piece => piece.square === square)?.id
}

// Stable identity is what lets a piece slide instead of teleport: the moved
// piece must keep the same `id` (DOM node) across the position change.
describe('usePieceLayout identity reconciliation', () => {
  it('keeps the id of a quietly moved piece and updates its grid position', async () => {
    const { pieces, layout } = setup({ e2: W('p') })
    const before = idAt(layout, 'e2')
    expect(before).toBeDefined()

    pieces.value = { e4: W('p') }
    await nextTick()

    expect(idAt(layout, 'e4')).toBe(before)
    const moved = layout.value.find(piece => piece.square === 'e4')
    expect(moved?.col).toBe(4)
    expect(moved?.row).toBe(4)
  })

  it('retires the captured piece and lets the capturer keep its id', async () => {
    const { pieces, layout } = setup({ e4: W('p'), d5: B('p') })
    const capturerId = idAt(layout, 'e4')

    pieces.value = { d5: W('p') }
    await nextTick()

    expect(layout.value).toHaveLength(1)
    expect(idAt(layout, 'd5')).toBe(capturerId)
  })

  it('slides both king and rook on castling, each keeping its id', async () => {
    const { pieces, layout } = setup({ e1: W('k'), h1: W('r') })
    const kingId = idAt(layout, 'e1')
    const rookId = idAt(layout, 'h1')

    pieces.value = { g1: W('k'), f1: W('r') }
    await nextTick()

    expect(idAt(layout, 'g1')).toBe(kingId)
    expect(idAt(layout, 'f1')).toBe(rookId)
  })

  it('keeps the mover id through promotion while updating the role', async () => {
    const { pieces, layout } = setup({ e7: W('p') })
    const pawnId = idAt(layout, 'e7')

    pieces.value = { e8: W('q') }
    await nextTick()

    expect(idAt(layout, 'e8')).toBe(pawnId)
    expect(layout.value.find(piece => piece.square === 'e8')?.role).toBe('q')
  })

  it('assigns fresh ids on a wholesale change so it cross-fades instead of sliding', async () => {
    const { pieces, layout } = setup({ a1: W('r'), b1: W('n'), c1: W('b'), d1: W('q'), e1: W('k') })
    const beforeIds = new Set(layout.value.map(piece => piece.id))

    // More than two squares change at once → not a legal single move → no reuse.
    pieces.value = { a8: B('r'), b8: B('n'), c8: B('b'), d8: B('q'), e8: B('k') }
    await nextTick()

    for (const piece of layout.value) {
      expect(beforeIds.has(piece.id)).toBe(false)
    }
  })
})
