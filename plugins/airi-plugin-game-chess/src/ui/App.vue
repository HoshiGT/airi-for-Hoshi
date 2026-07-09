<script setup lang="ts">
import type { WidgetsIframeInitPayload } from '@proj-airi/plugin-sdk-tamagotchi/widgets'

import type { Difficulty, MatchMode, Side, Variant } from '../shared/types'

import { onBeforeUnmount, watch } from 'vue'

import Board from './components/Board.vue'

import { createAiriBridge } from './composables/use-airi-bridge'
import { useGame } from './composables/use-game'

const bridge = createAiriBridge()
const game = useGame(bridge)

const VARIANTS: { value: Variant, label: string }[] = [
  { value: 'chess', label: 'International Chess' },
  { value: 'xiangqi', label: 'Chinese Chess (Xiangqi)' },
]
const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard']

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Reads the host-provided match settings, preferring the runtime props payload
 * (set by the `play_chess` tool's `open`) over the mount-time init config.
 */
function readSettings(init: WidgetsIframeInitPayload): Record<string, unknown> {
  const fromProps = asRecord(asRecord(init.props)?.payload)
  const mountConfig = asRecord(asRecord(init.config)?.config)
  const fromInit = asRecord(mountConfig?.init)
  return { ...fromInit, ...fromProps }
}

watch(bridge.init, (init) => {
  if (!init || game.phase.value !== 'setup') {
    return
  }
  const settings = readSettings(init)

  if (settings.variant === 'chess' || settings.variant === 'xiangqi') {
    game.changeVariant(settings.variant)
  }
  if (settings.mode === 'vs-airi' || settings.mode === 'two-player') {
    game.mode.value = settings.mode as MatchMode
  }
  if (settings.airiSide === 'first' || settings.airiSide === 'second') {
    game.airiSide.value = settings.airiSide as Side
  }
  if (DIFFICULTIES.includes(settings.difficulty as Difficulty)) {
    game.difficulty.value = settings.difficulty as Difficulty
  }
  // The tool may request an immediate match instead of showing the setup panel.
  if (settings.autoStart === true) {
    void game.startGame()
  }
})

onBeforeUnmount(() => bridge.dispose())
</script>

<template>
  <main :class="['min-h-screen', 'w-full', 'p-4', 'flex', 'flex-col', 'gap-4', 'items-center', 'bg-neutral-50', 'dark:bg-neutral-950', 'text-neutral-900', 'dark:text-neutral-100']">
    <header :class="['w-full', 'max-w-120', 'flex', 'items-baseline', 'justify-between', 'gap-2']">
      <h1 :class="['text-lg', 'font-bold']">
        AIRI · {{ game.variant.value === 'xiangqi' ? '中国象棋' : 'Chess' }}
      </h1>
      <span :class="['text-sm', 'text-neutral-500', 'dark:text-neutral-400']">{{ game.statusText.value }}</span>
    </header>

    <Board
      :variant="game.variant.value"
      :cols="game.cols.value"
      :rows="game.rows.value"
      :square-at="game.squareAt.value"
      :pieces="game.pieces.value"
      :selected="game.selected.value"
      :targets="game.targets.value"
      :last-move="game.lastMove.value"
      @square-click="game.onSquareClick"
    />

    <section
      v-if="game.phase.value === 'setup'"
      :class="['w-full', 'max-w-120', 'flex', 'flex-col', 'gap-3', 'p-4', 'rounded-lg', 'bg-white', 'dark:bg-neutral-900', 'ring-1', 'ring-neutral-200', 'dark:ring-neutral-800']"
    >
      <h2 :class="['text-base', 'font-semibold']">
        Match Setup
      </h2>

      <div :class="['flex', 'flex-col', 'gap-1']">
        <span :class="['text-xs', 'uppercase', 'tracking-wide', 'text-neutral-500']">Game</span>
        <div :class="['flex', 'gap-2', 'flex-wrap']">
          <button
            v-for="option in VARIANTS"
            :key="option.value"
            type="button"
            :class="[
              'px-3 py-1.5 rounded-md text-sm ring-1 ring-neutral-300 dark:ring-neutral-700',
              game.variant.value === option.value ? 'bg-sky-600 text-white ring-sky-600' : 'bg-transparent',
            ]"
            @click="game.changeVariant(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <div :class="['flex', 'flex-col', 'gap-1']">
        <span :class="['text-xs', 'uppercase', 'tracking-wide', 'text-neutral-500']">Mode</span>
        <div :class="['flex', 'gap-4', 'flex-wrap']">
          <label :class="['flex', 'items-center', 'gap-1.5', 'text-sm', 'cursor-pointer']">
            <input v-model="game.mode.value" type="radio" value="vs-airi"> Vs AIRI
          </label>
          <label :class="['flex', 'items-center', 'gap-1.5', 'text-sm', 'cursor-pointer']">
            <input v-model="game.mode.value" type="radio" value="two-player"> Two Players
          </label>
        </div>
      </div>

      <div v-if="game.mode.value === 'vs-airi'" :class="['flex', 'flex-col', 'gap-1']">
        <span :class="['text-xs', 'uppercase', 'tracking-wide', 'text-neutral-500']">AIRI plays</span>
        <div :class="['flex', 'gap-4', 'flex-wrap']">
          <label :class="['flex', 'items-center', 'gap-1.5', 'text-sm', 'cursor-pointer']">
            <input v-model="game.airiSide.value" type="radio" value="second">
            {{ game.variant.value === 'xiangqi' ? '黑（后手）' : 'Black (second)' }}
          </label>
          <label :class="['flex', 'items-center', 'gap-1.5', 'text-sm', 'cursor-pointer']">
            <input v-model="game.airiSide.value" type="radio" value="first">
            {{ game.variant.value === 'xiangqi' ? '红（先手）' : 'White (first)' }}
          </label>
        </div>
      </div>

      <div v-if="game.mode.value === 'vs-airi'" :class="['flex', 'flex-col', 'gap-1']">
        <span :class="['text-xs', 'uppercase', 'tracking-wide', 'text-neutral-500']">Difficulty</span>
        <select
          v-model="game.difficulty.value"
          :class="['px-2 py-1.5 rounded-md text-sm bg-transparent ring-1 ring-neutral-300 dark:ring-neutral-700 w-40']"
        >
          <option v-for="level in DIFFICULTIES" :key="level" :value="level">
            {{ level }}
          </option>
        </select>
      </div>

      <button
        type="button"
        :class="['mt-1', 'px-4 py-2', 'rounded-md', 'text-sm', 'font-semibold', 'bg-emerald-600', 'text-white', 'hover:bg-emerald-500']"
        @click="game.startGame()"
      >
        Start Game
      </button>
    </section>

    <section
      v-else
      :class="['w-full', 'max-w-120', 'flex', 'flex-col', 'gap-3', 'p-4', 'rounded-lg', 'bg-white', 'dark:bg-neutral-900', 'ring-1', 'ring-neutral-200', 'dark:ring-neutral-800']"
    >
      <p v-if="game.thinking.value" :class="['text-sm', 'text-sky-600', 'dark:text-sky-400', 'animate-pulse']">
        {{ game.airiThinkingLabel.value }}
      </p>
      <p v-if="game.commentary.value" :class="['text-sm', 'leading-relaxed']">
        <span :class="['font-semibold']">AIRI:</span> {{ game.commentary.value }}
      </p>
      <button
        type="button"
        :class="['self-start', 'px-3 py-1.5', 'rounded-md', 'text-sm', 'ring-1', 'ring-neutral-300', 'dark:ring-neutral-700']"
        @click="game.restart()"
      >
        New Match
      </button>
    </section>

    <p v-if="game.errorMessage.value" :class="['w-full', 'max-w-120', 'text-sm', 'text-red-600', 'dark:text-red-400']">
      {{ game.errorMessage.value }}
    </p>
  </main>
</template>
