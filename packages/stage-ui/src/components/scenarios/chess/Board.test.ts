// @vitest-environment jsdom

import type { BoardPiece } from './shared'

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import Board from './Board.vue'

// Chess square label with row 0 at the top (rank 8), mirroring rules.ts squareAt.
function chessSquareAt(col: number, row: number): string {
  return `${String.fromCharCode(97 + col)}${8 - row}`
}

function mountBoard(pieces: Record<string, BoardPiece>) {
  return mount(Board, {
    props: {
      variant: 'chess',
      cols: 8,
      rows: 8,
      squareAt: chessSquareAt,
      pieces,
      selected: '',
      targets: new Set<string>(),
    },
  })
}

/** Inline left/top of each overlay piece element, e.g. "50%,75%". */
function piecePositions(wrapper: ReturnType<typeof mountBoard>): string[] {
  // Piece overlay divs are the only elements positioned with an inline `left`.
  return wrapper.findAll('div[style*="left:"]').map((el) => {
    const style = (el.element as HTMLElement).style
    return `${style.left},${style.top}`
  })
}

describe('board piece positioning', () => {
  // ROOT CAUSE:
  //
  // Pieces used to be positioned with `transform: translate(...)`. <Transition-
  // Group> finishes its FLIP move by resetting `style.transform = ""`, which
  // wiped that positioning transform and dropped the piece to translate(0,0) =
  // a8 until the next reactive re-render (e.g. clicking a piece) re-applied it.
  //
  // We fixed it by positioning with left/top and letting the FLIP animate
  // `transform` separately (the `piece-move` class). Clearing the FLIP transform
  // then can't strand the piece, because its position is held by left/top.
  it('positions pieces with left/top, not transform (Issue: piece stuck at a8)', () => {
    const wrapper = mountBoard({
      e2: { side: 'first', role: 'p' },
      e7: { side: 'second', role: 'p' },
    })

    const positionDivs = wrapper.findAll('div[style*="left:"]')
    expect(positionDivs).toHaveLength(2)

    for (const el of positionDivs) {
      const style = (el.element as HTMLElement).style
      // Position lives on left/top; transform stays free for the FLIP slide so
      // TransitionGroup clearing it can never strand the piece at a8.
      expect(style.left).not.toBe('')
      expect(style.top).not.toBe('')
      expect(style.transform).toBe('')
    }
  })

  it('maps each piece to its square, not the a8 corner', () => {
    const wrapper = mountBoard({
      e2: { side: 'first', role: 'p' },
      e7: { side: 'second', role: 'p' },
    })

    // e2 = col 4, row 6 -> left 50%, top 75%; e7 = col 4, row 1 -> top 12.5%.
    const positions = piecePositions(wrapper)
    expect(positions).toContain('50%,75%')
    expect(positions).toContain('50%,12.5%')
    // Neither pawn sits on a8 (0%,0%).
    expect(positions).not.toContain('0%,0%')
  })

  it('slides the moved piece to its new square after a position change', async () => {
    const wrapper = mountBoard({
      e2: { side: 'first', role: 'p' },
      e7: { side: 'second', role: 'p' },
    })

    // Simulate e2 -> e4 (col 4, row 4 -> left 50%, top 50%).
    await wrapper.setProps({
      pieces: {
        e4: { side: 'first', role: 'p' },
        e7: { side: 'second', role: 'p' },
      },
    })

    const positions = piecePositions(wrapper)
    expect(positions).toContain('50%,50%')
    expect(positions).not.toContain('50%,75%')
    expect(positions).not.toContain('0%,0%')
  })
})
