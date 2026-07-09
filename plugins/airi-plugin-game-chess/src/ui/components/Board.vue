<script setup lang="ts">
import type { BoardPiece, Side, Variant } from '../../shared/types'

import { computed } from 'vue'

const props = defineProps<{
  variant: Variant
  cols: number
  rows: number
  squareAt: (col: number, row: number) => string
  pieces: Record<string, BoardPiece>
  selected: string
  targets: Set<string>
  lastMove?: { from: string, to: string }
}>()

const emit = defineEmits<{ (event: 'squareClick', square: string): void }>()

// Glyphs per variant and side. `first` is White (chess) / Red (xiangqi).
const GLYPHS: Record<Variant, Record<Side, Record<string, string>>> = {
  chess: {
    first: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
    second: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
  },
  xiangqi: {
    first: { k: '帅', a: '仕', b: '相', n: '马', r: '车', c: '炮', p: '兵' },
    second: { k: '将', a: '士', b: '象', n: '馬', r: '車', c: '砲', p: '卒' },
  },
}

interface Cell {
  square: string
  glyph: string
  side?: Side
  dark: boolean
  selected: boolean
  target: boolean
  lastMove: boolean
}

const cells = computed<Cell[]>(() => {
  const list: Cell[] = []
  for (let row = 0; row < props.rows; row++) {
    for (let col = 0; col < props.cols; col++) {
      const square = props.squareAt(col, row)
      const piece = props.pieces[square]
      list.push({
        square,
        glyph: piece ? GLYPHS[props.variant][piece.side][piece.role] ?? '?' : '',
        side: piece?.side,
        // Checkerboard tint for chess only; xiangqi uses a uniform board colour.
        dark: props.variant === 'chess' && (col + row) % 2 === 1,
        selected: props.selected === square,
        target: props.targets.has(square),
        lastMove: props.lastMove?.from === square || props.lastMove?.to === square,
      })
    }
  }
  return list
})
</script>

<template>
  <div
    :class="['grid', 'w-full', 'max-w-120', 'mx-auto', 'rounded-md', 'overflow-hidden', 'select-none', 'ring-1', 'ring-neutral-300', 'dark:ring-neutral-700']"
    :style="{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }"
  >
    <button
      v-for="cell in cells"
      :key="cell.square"
      :title="cell.square"
      type="button"
      :class="[
        'relative aspect-square flex items-center justify-center',
        'text-[clamp(1rem,5vw,2rem)] leading-none',
        variant === 'xiangqi' ? 'bg-amber-100 dark:bg-amber-900/40' : (cell.dark ? 'bg-emerald-700/80' : 'bg-emerald-100'),
        cell.lastMove ? 'ring-2 ring-inset ring-yellow-400' : '',
        cell.selected ? 'ring-2 ring-inset ring-sky-500' : '',
      ]"
      @click="emit('squareClick', cell.square)"
    >
      <span
        v-if="cell.glyph"
        :class="[
          'font-semibold',
          cell.side === 'first'
            ? (variant === 'xiangqi' ? 'text-red-600' : 'text-neutral-50 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]')
            : (variant === 'xiangqi' ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-900'),
        ]"
      >{{ cell.glyph }}</span>
      <span
        v-if="cell.target && !cell.glyph"
        :class="['absolute', 'w-1/4', 'h-1/4', 'rounded-full', 'bg-sky-500/60']"
      />
      <span
        v-if="cell.target && cell.glyph"
        :class="['absolute', 'inset-1', 'rounded-full', 'ring-2', 'ring-sky-500/70']"
      />
    </button>
  </div>
</template>
