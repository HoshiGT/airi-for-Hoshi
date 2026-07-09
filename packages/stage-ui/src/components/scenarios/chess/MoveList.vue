<script setup lang="ts">
import type { MoveQuality } from './review'

import { computed } from 'vue'

import { QUALITY_META } from './review'

const props = defineProps<{
  /** Moves of the current game in play order (SAN), first side then second. */
  history: string[]
  /**
   * Review grades aligned with `history`; providing them switches the list to
   * the interactive review mode (clickable moves, quality marks).
   */
  annotations?: { quality: MoveQuality }[]
  /** Ply index highlighted as the viewed review position; -1 = none. */
  activeIndex?: number
}>()

const emit = defineEmits<{ (event: 'select', index: number): void }>()

interface Entry {
  index: number
  san: string
  quality?: MoveQuality
}

// Pair moves by number for standard notation: row N = (first-side, second-side).
const rows = computed(() => {
  const out: { no: number, entries: Entry[] }[] = []
  for (let i = 0; i < props.history.length; i += 2) {
    const entries: Entry[] = []
    for (const index of [i, i + 1]) {
      if (props.history[index] != null) {
        entries.push({ index, san: props.history[index], quality: props.annotations?.[index]?.quality })
      }
    }
    out.push({ no: i / 2 + 1, entries })
  }
  return out
})

// Only decisive grades get a mark; unmarked moves read as ordinary. The mark is
// always symbol + color together (never color alone).
const QUALITY_MARK: Partial<Record<MoveQuality, string>> = {
  best: 'text-emerald-600 dark:text-emerald-400',
  inaccuracy: 'text-amber-600 dark:text-amber-400',
  mistake: 'text-orange-600 dark:text-orange-400',
  blunder: 'text-red-600 dark:text-red-400',
}
</script>

<template>
  <div
    :class="['w-full', 'max-w-120', 'mx-auto', 'rounded-lg', 'bg-white', 'dark:bg-neutral-900', 'ring-1', 'ring-neutral-200', 'dark:ring-neutral-800', 'p-3', 'flex', 'flex-col', 'gap-2']"
  >
    <span :class="['text-sm', 'font-semibold']">着法记录</span>

    <p v-if="!rows.length" :class="['text-xs', 'text-neutral-400']">
      还没走子
    </p>

    <div v-else :class="['flex', 'flex-wrap', 'gap-x-3', 'gap-y-1', 'max-h-40', 'overflow-y-auto', 'font-mono', 'text-sm', 'leading-relaxed']">
      <span v-for="row in rows" :key="row.no" :class="['whitespace-nowrap']">
        <span :class="['text-neutral-400', 'mr-1']">{{ row.no }}.</span>
        <template v-for="(entry, position) in row.entries" :key="entry.index">
          <button
            v-if="annotations"
            type="button"
            :class="[
              'rounded px-0.5',
              position > 0 ? 'ml-1' : '',
              entry.index === activeIndex
                ? 'bg-sky-600 text-white'
                : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
            ]"
            @click="emit('select', entry.index)"
          >{{ entry.san }}<span
            v-if="entry.quality && QUALITY_MARK[entry.quality]"
            :class="['ml-0.5', entry.index === activeIndex ? '' : QUALITY_MARK[entry.quality]]"
          >{{ QUALITY_META[entry.quality].symbol }}</span></button>
          <span v-else :class="[position > 0 ? 'ml-1' : '']">{{ entry.san }}</span>
        </template>
      </span>
    </div>
  </div>
</template>
