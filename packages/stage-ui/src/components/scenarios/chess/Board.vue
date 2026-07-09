<script setup lang="ts">
import type { BoardPiece, Side, Variant } from './shared'

import { computed, toRef } from 'vue'

import chessPiecesSprite from './assets/chess-pieces-sprite.svg?url'
import xiangqiBoard from './assets/xiangqi/xiangqi-board.svg?url'
import xiangqiPiecesSprite from './assets/xiangqi/xiangqi-pieces-sprite.svg?url'

import { usePieceLayout } from './use-piece-layout'

const props = defineProps<{
  variant: Variant
  cols: number
  rows: number
  squareAt: (col: number, row: number) => string
  pieces: Record<string, BoardPiece>
  selected: string
  targets: Set<string>
  lastMove?: { from: string, to: string }
  /** Whether the side to move is in check; glows that side's king. */
  inCheck?: boolean
  /** Side to move, used to locate the checked king. */
  turn?: Side
}>()

const emit = defineEmits<{ (event: 'squareClick', square: string): void }>()

// NOTICE: piece-skin render points live in the template's pieces overlay.
// Both variants render from an SVG sprite via background-position: chess from
// the Wikimedia set, xiangqi from a flat red/black disc set (assets/xiangqi/).
// The animation layer (stable id, left/top position, FLIP slide) is skin-agnostic.

// Chess pieces come from one 270×90 sprite: 6 columns × 2 rows of 45px cells,
// column order K Q B N R P, white on the top row and black on the bottom.
const CHESS_SPRITE_COL: Record<string, number> = { k: 0, q: 1, b: 2, n: 3, r: 4, p: 5 }

function chessSpriteStyle(side: Side, role: string): Record<string, string> {
  const col = CHESS_SPRITE_COL[role] ?? CHESS_SPRITE_COL.p
  const row = side === 'first' ? 0 : 1
  return {
    backgroundImage: `url(${chessPiecesSprite})`,
    backgroundSize: '600% 200%',
    // Percentage positioning of a multi-cell sprite: col/(cols-1), row/(rows-1).
    backgroundPosition: `${(col / 5) * 100}% ${row * 100}%`,
    backgroundRepeat: 'no-repeat',
  }
}

// Xiangqi pieces come from one 336×96 sprite: 7 columns × 2 rows of 48px cells,
// column order K A B N R C P, red (first) on the top row and black on the
// bottom. Each cell is a solid disc with the glyph in white; the disc already
// carries margin inside its cell, so the render div spans the full square.
const XIANGQI_SPRITE_COL: Record<string, number> = { k: 0, a: 1, b: 2, n: 3, r: 4, c: 5, p: 6 }

function xiangqiSpriteStyle(side: Side, role: string): Record<string, string> {
  const col = XIANGQI_SPRITE_COL[role] ?? XIANGQI_SPRITE_COL.p
  const row = side === 'first' ? 0 : 1
  return {
    backgroundImage: `url(${xiangqiPiecesSprite})`,
    backgroundSize: '700% 200%',
    backgroundPosition: `${(col / 6) * 100}% ${row * 100}%`,
    backgroundRepeat: 'no-repeat',
  }
}

// Stable-identity overlay pieces; their `transform` is what slides on a move.
const layout = usePieceLayout(
  toRef(props, 'pieces'),
  toRef(props, 'cols'),
  toRef(props, 'rows'),
  toRef(props, 'squareAt'),
)

// The checked side's king square gets a red glow; empty when not in check.
const checkedKingSquare = computed(() => {
  if (!props.inCheck || !props.turn) {
    return ''
  }
  return Object.keys(props.pieces).find((square) => {
    const piece = props.pieces[square]
    return piece.role === 'k' && piece.side === props.turn
  }) ?? ''
})

interface Cell {
  square: string
  dark: boolean
  selected: boolean
  target: boolean
  occupied: boolean
  lastMove: boolean
  check: boolean
}

const cells = computed<Cell[]>(() => {
  const list: Cell[] = []
  for (let row = 0; row < props.rows; row++) {
    for (let col = 0; col < props.cols; col++) {
      const square = props.squareAt(col, row)
      list.push({
        square,
        // Checkerboard tint for chess only; the xiangqi board is drawn by the
        // container's background SVG and its cells stay transparent.
        dark: props.variant === 'chess' && (col + row) % 2 === 1,
        selected: props.selected === square,
        target: props.targets.has(square),
        occupied: square in props.pieces,
        lastMove: props.lastMove?.from === square || props.lastMove?.to === square,
        check: checkedKingSquare.value === square,
      })
    }
  }
  return list
})
</script>

<template>
  <!-- Xiangqi board art is one SVG stretched over the container. Its grid lines
       run through the CENTERS of the 48px cells (line k at 24+48k), so pieces
       laid out per-cell land visually on the intersections, as xiangqi expects;
       the cells stay the click targets. 432×480 matches the 9:10 cell ratio. -->
  <div
    :class="['relative', 'w-full', 'max-w-120', 'mx-auto', 'rounded-md', 'overflow-hidden', 'select-none', 'ring-1', 'ring-neutral-300', 'dark:ring-neutral-700']"
    :style="variant === 'xiangqi'
      ? { backgroundImage: `url(${xiangqiBoard})`, backgroundSize: '100% 100%' }
      : undefined"
  >
    <div
      :class="['grid', 'w-full']"
      :style="{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }"
    >
      <button
        v-for="cell in cells"
        :key="cell.square"
        :title="cell.square"
        type="button"
        :class="[
          'relative aspect-square',
          // Chess.com-style cream/green: high contrast against both white and
          // black pieces (the old emerald pair blended with the piece colours).
          // Xiangqi cells stay transparent — the container's board art shows through.
          variant === 'chess' ? (cell.dark ? 'bg-[#769656]' : 'bg-[#eeeed2]') : '',
        ]"
        @click="emit('squareClick', cell.square)"
      >
        <!-- Last-move and selection tints sit under the pieces overlay. -->
        <span v-if="cell.lastMove" :class="['absolute', 'inset-0', 'bg-yellow-400/35']" />
        <span v-if="cell.selected" :class="['absolute', 'inset-0', 'bg-yellow-400/50']" />
        <!-- Checked king glow. -->
        <span
          v-if="cell.check"
          :class="['absolute', 'inset-0', 'bg-[radial-gradient(circle,rgba(239,68,68,0.7),transparent_70%)]']"
        />
        <!-- Legal-move hint: a dot on empty squares, a ring hugging a capturable piece.
             No dark: variant on purpose — the board colours are fixed (cream/green
             cells, light wooden xiangqi art) and do not follow the app theme, so a
             theme-flipped light dot would vanish on the cream squares. -->
        <span
          v-if="cell.target && !cell.occupied"
          :class="['absolute', 'inset-0', 'm-auto', 'w-1/4', 'h-1/4', 'rounded-full', 'bg-neutral-900/40']"
        />
        <span
          v-if="cell.target && cell.occupied"
          :class="['absolute', 'inset-[7%]', 'rounded-full', 'ring-[3px]', 'ring-inset', 'ring-neutral-900/40']"
        />
      </button>
    </div>

    <!-- Pieces overlay: one element per stable id. A move slides via the group's
         FLIP move animation; captured/spawned pieces fade via the group transition. -->
    <!-- NOTICE:
         Positioning is left/top; the slide is animated by <TransitionGroup>'s
         built-in FLIP move (the `piece-move` class transitions `transform`).
         Keeping these on SEPARATE properties is deliberate. <TransitionGroup>
         finishes a move by resetting `style.transform = ""`
         (node_modules/@vue/runtime-dom .../runtime-dom.cjs.js, the move block).
         Earlier the piece was *positioned* with `transform: translate`, so that
         reset stranded it at translate(0,0) = left:0/top:0 = a8 until the next
         re-render. With positioning on left/top, clearing the FLIP transform is
         harmless — the piece stays put — and we still get a smooth GPU transform
         slide. (FLIP needs a transform transition to engage: `hasCSSTransform`
         clones a child + the move class and tests its transition against
         /\b(?:transform|all)/, which `piece-move` satisfies.) -->
    <TransitionGroup
      tag="div"
      :class="['absolute', 'inset-0', 'pointer-events-none']"
      move-class="piece-move"
      enter-active-class="transition-opacity duration-150 ease-out"
      leave-active-class="transition-opacity duration-150 ease-in"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-for="piece in layout"
        :key="piece.id"
        :class="['absolute', 'flex', 'items-center', 'justify-center']"
        :style="{
          width: `${100 / cols}%`,
          height: `${100 / rows}%`,
          left: `${(piece.col * 100) / cols}%`,
          top: `${(piece.row * 100) / rows}%`,
        }"
      >
        <!-- Sprite cell for either variant. Selection lifts the piece slightly. -->
        <div
          :class="[
            // Chess sprite cells are tightly cropped, so inset the div; the
            // xiangqi disc has margin baked into its 48px cell, so span fully.
            variant === 'chess' ? 'w-[88%] h-[88%]' : 'w-full h-full',
            'transition-transform duration-150',
            // Base shadow lifts every piece off the square; selection deepens it.
            piece.square === selected
              ? 'scale-110 drop-shadow-[0_2px_3px_rgba(0,0,0,0.45)]'
              : 'drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.4)]',
          ]"
          :style="variant === 'chess'
            ? chessSpriteStyle(piece.side, piece.role)
            : xiangqiSpriteStyle(piece.side, piece.role)"
        />
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
/* TransitionGroup move animation: the smooth GPU slide when a piece changes
   square. Applied by `move-class` while the group reconciles a position change.
   See the NOTICE in the template for why the slide rides `transform` while
   positioning rides left/top. */
.piece-move {
  /* Linear-out-slow-in (Material "decelerate"): enters at full speed and eases
     to a stop — reads smoother than a snappy ease-out-expo curve. `will-change`
     hints the compositor; it is only on the element while the move class is set. */
  transition: transform 280ms cubic-bezier(0, 0, 0.2, 1);
  will-change: transform;
}
</style>
