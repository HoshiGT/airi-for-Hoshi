<script setup lang="ts">
import type { GameReview, MoveQuality, ReviewedPly } from './review'
import type { Side, Variant } from './shared'

import { computed, ref } from 'vue'

import { QUALITY_META } from './review'

const props = defineProps<{
  variant: Variant
  status: 'idle' | 'running' | 'done' | 'error'
  progress: { done: number, total: number }
  error: string
  review?: GameReview
  /** Viewed position: -1 = start, k ≥ 0 = after ply k. */
  selectedPly: number
}>()

const emit = defineEmits<{
  (event: 'start'): void
  (event: 'select', index: number): void
}>()

function sideName(side: Side): string {
  if (side === 'first') {
    return props.variant === 'xiangqi' ? '红方' : '白方'
  }
  return '黑方'
}

// Full grade → color map for the current-move chip and the summary counts.
// Grades always render as label/symbol + color together, never color alone.
const QUALITY_COLOR: Record<MoveQuality, string> = {
  best: 'text-emerald-600 dark:text-emerald-400',
  excellent: 'text-emerald-600 dark:text-emerald-400',
  good: 'text-neutral-500 dark:text-neutral-400',
  inaccuracy: 'text-amber-600 dark:text-amber-400',
  mistake: 'text-orange-600 dark:text-orange-400',
  blunder: 'text-red-600 dark:text-red-400',
}

const current = computed<ReviewedPly | undefined>(() =>
  props.selectedPly >= 0 ? props.review?.plies[props.selectedPly] : undefined)
const totalPlies = computed(() => props.review?.plies.length ?? 0)

/** Grade text for the viewed move; the ?!/?/?? annotation joins the label. */
const currentGrade = computed(() => {
  if (!current.value) {
    return ''
  }
  const meta = QUALITY_META[current.value.quality]
  return ['?!', '?', '??'].includes(meta.symbol) ? `${meta.label} ${meta.symbol}` : meta.label
})

/** Signed pawns for display; forced-mate scores read as a decided game. */
function evalText(cp: number): string {
  if (cp >= 9000) {
    return `${sideName('first')}胜定`
  }
  if (cp <= -9000) {
    return `${sideName('second')}胜定`
  }
  const pawns = cp / 100
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)}`
}

// --- Evaluation graph ---------------------------------------------------
// One point per position (start + after each ply), evaluation from the first
// side's POV clamped to ±6 pawns so mates don't flatten the mid-game shape.
// The SVG carries only the line/area (non-scaling stroke survives the
// stretched viewBox); the crosshair, marker dot, and tooltip are HTML overlay
// positioned by percentage so they stay undistorted.

const CLAMP_CP = 600
const GRAPH_W = 480
const GRAPH_H = 96

interface GraphPoint {
  /** Viewed-position index for this point: -1 = start, k ≥ 0 = after ply k. */
  index: number
  xPct: number
  yPct: number
  cp: number
}

const points = computed<GraphPoint[]>(() => {
  if (!props.review || props.review.plies.length === 0) {
    return []
  }
  const evals = [props.review.startEvalCp, ...props.review.plies.map(ply => ply.evalAfterCp)]
  const segments = evals.length - 1
  return evals.map((cp, k) => ({
    index: k - 1,
    xPct: (k / segments) * 100,
    // 50% is the balanced midline; ±44% leaves breathing room at the edges.
    yPct: 50 - (Math.max(-CLAMP_CP, Math.min(CLAMP_CP, cp)) / CLAMP_CP) * 44,
    cp,
  }))
})

const linePath = computed(() => points.value
  .map((point, k) => `${k === 0 ? 'M' : 'L'} ${(point.xPct / 100) * GRAPH_W} ${(point.yPct / 100) * GRAPH_H}`)
  .join(' '))
const areaPath = computed(() => {
  if (!points.value.length) {
    return ''
  }
  const last = points.value[points.value.length - 1]
  return `${linePath.value} L ${(last.xPct / 100) * GRAPH_W} ${GRAPH_H / 2} L 0 ${GRAPH_H / 2} Z`
})

const hoverPoint = ref<GraphPoint>()

function pointAtEvent(event: PointerEvent | MouseEvent): GraphPoint | undefined {
  const target = event.currentTarget as HTMLElement
  const segments = points.value.length - 1
  if (segments < 1) {
    return undefined
  }
  const pct = (event.clientX - target.getBoundingClientRect().left) / target.clientWidth
  const k = Math.round(Math.max(0, Math.min(1, pct)) * segments)
  return points.value[k]
}

const selectedPoint = computed(() =>
  points.value.find(point => point.index === props.selectedPly))

function tooltipText(point: GraphPoint): string {
  if (point.index < 0) {
    return `开局 ${evalText(point.cp)}`
  }
  const ply = props.review?.plies[point.index]
  return `第${point.index + 1}手 ${ply?.san ?? ''} ${evalText(point.cp)}`
}

// --- Navigation ----------------------------------------------------------

const summarySides: Side[] = ['first', 'second']
const countKeys = ['inaccuracy', 'mistake', 'blunder'] as const
</script>

<template>
  <section
    :class="['w-full', 'max-w-120', 'flex', 'flex-col', 'gap-3', 'p-4', 'rounded-lg', 'bg-white', 'dark:bg-neutral-900', 'ring-1', 'ring-neutral-200', 'dark:ring-neutral-800']"
  >
    <div :class="['flex', 'items-baseline', 'justify-between']">
      <h3 :class="['text-base', 'font-semibold']">
        复盘
      </h3>
      <span v-if="status === 'done'" :class="['text-xs', 'text-neutral-400']">点曲线或着法跳到局面</span>
    </div>

    <template v-if="status === 'idle'">
      <p :class="['text-xs', 'text-neutral-400']">
        用引擎逐手回算这盘棋，标出每步走得如何、哪里错过了更好的着法。
      </p>
      <button
        type="button"
        :class="['self-start', 'px-4 py-2', 'rounded-md', 'text-sm', 'font-semibold', 'bg-sky-600', 'text-white', 'hover:bg-sky-500']"
        @click="emit('start')"
      >
        复盘分析
      </button>
    </template>

    <template v-else-if="status === 'running'">
      <p :class="['text-sm', 'text-sky-600', 'dark:text-sky-400']">
        分析中… {{ progress.done }}/{{ progress.total }}
      </p>
      <!-- Meter: filled arm in the accent, track a lighter step of the same hue. -->
      <div :class="['h-1.5', 'w-full', 'rounded-full', 'overflow-hidden', 'bg-sky-100', 'dark:bg-sky-950']">
        <div
          :class="['h-full', 'bg-sky-600', 'transition-all', 'duration-200']"
          :style="{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }"
        />
      </div>
    </template>

    <template v-else-if="status === 'error'">
      <p :class="['text-sm', 'text-red-600', 'dark:text-red-400']">
        {{ error }}
      </p>
      <button
        type="button"
        :class="['self-start', 'px-3 py-1.5', 'rounded-md', 'text-sm', 'ring-1', 'ring-neutral-300', 'dark:ring-neutral-700']"
        @click="emit('start')"
      >
        重试
      </button>
    </template>

    <template v-else-if="review">
      <!-- Per-side counts of the moves that mattered. -->
      <div :class="['flex', 'flex-wrap', 'gap-x-4', 'gap-y-1', 'text-xs']">
        <span v-for="side in summarySides" :key="side" :class="['flex', 'items-center', 'gap-2']">
          <span :class="['text-neutral-500', 'dark:text-neutral-400', 'font-semibold']">{{ sideName(side) }}</span>
          <span v-for="key in countKeys" :key="key" :class="[QUALITY_COLOR[key]]">
            {{ QUALITY_META[key].label }} {{ review.counts[side][key] }}
          </span>
        </span>
      </div>

      <!-- Evaluation graph: above the midline = first side ahead. -->
      <div
        :class="['relative', 'w-full', 'h-24', 'rounded-md', 'overflow-hidden', 'bg-neutral-50', 'dark:bg-neutral-950', 'cursor-pointer', 'select-none']"
        @pointermove="hoverPoint = pointAtEvent($event)"
        @pointerleave="hoverPoint = undefined"
        @click="(event) => { const point = pointAtEvent(event); if (point) { emit('select', point.index) } }"
      >
        <svg
          :viewBox="`0 0 ${GRAPH_W} ${GRAPH_H}`"
          preserveAspectRatio="none"
          :class="['absolute', 'inset-0', 'w-full', 'h-full', 'text-[#2a78d6]', 'dark:text-[#3987e5]']"
        >
          <!-- Balanced midline (hairline). -->
          <line
            x1="0" :y1="GRAPH_H / 2" :x2="GRAPH_W" :y2="GRAPH_H / 2"
            :class="['stroke-neutral-300', 'dark:stroke-neutral-700']"
            stroke-width="1" vector-effect="non-scaling-stroke"
          />
          <path :d="areaPath" fill="currentColor" fill-opacity="0.1" />
          <path
            :d="linePath" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"
          />
        </svg>

        <!-- Pole labels: identity by text, not color. -->
        <span :class="['absolute', 'left-1.5', 'top-0.5', 'text-[10px]', 'text-neutral-400', 'pointer-events-none']">{{ sideName('first') }}优</span>
        <span :class="['absolute', 'left-1.5', 'bottom-0.5', 'text-[10px]', 'text-neutral-400', 'pointer-events-none']">{{ sideName('second') }}优</span>

        <!-- Crosshair + tooltip on hover. -->
        <template v-if="hoverPoint">
          <div
            :class="['absolute', 'top-0', 'bottom-0', 'w-px', 'bg-neutral-400/60', 'pointer-events-none']"
            :style="{ left: `${hoverPoint.xPct}%` }"
          />
          <div
            :class="['absolute', 'top-1', 'px-1.5', 'py-0.5', 'rounded', 'text-[11px]', 'whitespace-nowrap', 'bg-neutral-800/90', 'text-white', 'pointer-events-none', '-translate-x-1/2']"
            :style="{ left: `clamp(3rem, ${hoverPoint.xPct}%, calc(100% - 3rem))` }"
          >
            {{ tooltipText(hoverPoint) }}
          </div>
        </template>

        <!-- Viewed-position marker with a surface ring so it reads over the line. -->
        <div
          v-if="selectedPoint"
          :class="['absolute', 'w-2.5', 'h-2.5', 'rounded-full', 'pointer-events-none', '-translate-x-1/2', '-translate-y-1/2', 'bg-[#2a78d6]', 'dark:bg-[#3987e5]', 'ring-2', 'ring-neutral-50', 'dark:ring-neutral-950']"
          :style="{ left: `${selectedPoint.xPct}%`, top: `${selectedPoint.yPct}%` }"
        />
      </div>

      <!-- Walkthrough controls + the viewed move's grade. -->
      <div :class="['flex', 'items-center', 'gap-2', 'flex-wrap']">
        <div :class="['flex', 'gap-1']">
          <button
            v-for="nav in [
              { label: '⏮', title: '开局', target: -1, enabled: selectedPly > -1 },
              { label: '◀', title: '上一步', target: selectedPly - 1, enabled: selectedPly > -1 },
              { label: '▶', title: '下一步', target: selectedPly + 1, enabled: selectedPly < totalPlies - 1 },
              { label: '⏭', title: '终局', target: totalPlies - 1, enabled: selectedPly < totalPlies - 1 },
            ]"
            :key="nav.label"
            type="button"
            :title="nav.title"
            :disabled="!nav.enabled"
            :class="['px-2', 'py-1', 'rounded-md', 'text-sm', 'ring-1', 'ring-neutral-300', 'dark:ring-neutral-700', 'disabled:opacity-40']"
            @click="emit('select', nav.target)"
          >
            {{ nav.label }}
          </button>
        </div>

        <span v-if="!current" :class="['text-sm', 'text-neutral-500', 'dark:text-neutral-400']">开局局面</span>
        <template v-else>
          <span :class="['text-sm', 'font-mono']">第{{ selectedPly + 1 }}手 {{ current.san }}</span>
          <span :class="['text-sm', 'font-semibold', QUALITY_COLOR[current.quality]]">
            {{ currentGrade }}
          </span>
          <span :class="['text-sm', 'text-neutral-500', 'dark:text-neutral-400']">局面 {{ evalText(current.evalAfterCp) }}</span>
          <span v-if="current.betterSan" :class="['text-sm', 'text-neutral-500', 'dark:text-neutral-400']">更好：<span :class="['font-mono']">{{ current.betterSan }}</span></span>
        </template>
      </div>
    </template>
  </section>
</template>
