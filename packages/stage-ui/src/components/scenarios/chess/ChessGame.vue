<script setup lang="ts">
import type { PlayerLevel } from './move-policy'
import type { Variant } from './shared'
import type { RequestAiriMove } from './use-chess-game'

import { nextTick, ref, watch } from 'vue'

import Board from './Board.vue'
import CoachChat from './CoachChat.vue'
import MoveList from './MoveList.vue'
import ReviewPanel from './ReviewPanel.vue'

import { DEFAULT_COACH_PROMPT } from './shared'
import { useChessCoach } from './use-chess-coach'
import { useChessGame } from './use-chess-game'
import { useChessVoice } from './use-chess-voice'
import { useGameReview } from './use-game-review'

const props = defineProps<{
  /** Initial variant selected in the setup panel. */
  defaultVariant?: Variant
  /** Initial player level selected in the setup panel. */
  defaultLevel?: PlayerLevel
  /** Custom coach persona/instructions; falls back to the built-in default. */
  coachPrompt?: string
  /**
   * Optional move source for the opponent. When omitted the local engine plays
   * its own best move; provide this to let Airi choose among candidates.
   */
  requestAiriMove?: RequestAiriMove
}>()

const game = useChessGame({ requestAiriMove: props.requestAiriMove })

// Reactive coach: answers Hoshi's questions about the live position. The engine
// still picks Airi's moves; this only explains/advises when asked.
const coach = useChessCoach(
  {
    variant: () => game.variant.value,
    board: () => game.describeBoard(),
    turn: () => game.turn.value,
    history: () => game.history.value,
    airiSide: () => game.airiSide.value,
    playerLevel: () => game.playerLevel.value,
    engineHint: () => game.analyzeForCoach(),
  },
  () => props.coachPrompt?.trim() || DEFAULT_COACH_PROMPT,
)

// Hands-free voice: a recognized utterance is asked to the coach and its reply
// is spoken back. Voice-in → voice-out only; typed questions stay silent.
const voice = useChessVoice({
  onTranscript: text => coach.ask(text),
})

// Post-game review (复盘): grades every move once the game is over and lets the
// board step through the positions. While a position is being viewed the board
// renders the review's snapshot instead of the live (final) game state.
const review = useGameReview({
  variant: () => game.variant.value,
  plies: () => game.plies.value,
  result: () => game.result.value,
})

const VARIANTS: { value: Variant, label: string }[] = [
  { value: 'chess', label: 'International Chess' },
  { value: 'xiangqi', label: 'Chinese Chess (Xiangqi)' },
]
// Self-declared strength shown at setup; drives how much Airi eases (放水).
const LEVELS: { value: PlayerLevel, label: string }[] = [
  { value: 'beginner', label: '入门' },
  { value: 'novice', label: '初级' },
  { value: 'amateur', label: '中级' },
  { value: 'advanced', label: '高级' },
  { value: 'master', label: '大师' },
]

const rootEl = ref<HTMLElement>()

// A coach conversation is about one game's position, so start each new match
// fresh — phase only enters 'playing' via startGame(), never mid-game.
watch(() => game.phase.value, (phase) => {
  if (phase === 'playing') {
    coach.clear()
    // "Start Game" sits at the bottom of the setup panel, so the settings page
    // is scrolled well past the board when play begins — the opponent's back
    // ranks end up clipped above the scroll area (and its scrollbar is hidden,
    // so nothing hints at it). Bring the whole board back into view.
    nextTick(() => rootEl.value?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }
  else if (phase === 'setup') {
    // New match returns to setup (CoachChat hides); release the mic so it is
    // never left hot on the setup screen, and drop the previous game's review.
    voice.disable()
    review.reset()
  }
})

// Apply host-provided defaults while still in setup.
watch(() => [props.defaultVariant, props.defaultLevel] as const, ([variant, level]) => {
  if (game.phase.value !== 'setup') {
    return
  }
  if (variant && game.variant.value !== variant) {
    game.changeVariant(variant)
  }
  if (level) {
    game.playerLevel.value = level
  }
}, { immediate: true })
</script>

<template>
  <div ref="rootEl" :class="['w-full', 'flex', 'flex-col', 'gap-4', 'items-center']">
    <div :class="['w-full', 'max-w-120', 'flex', 'items-baseline', 'justify-between', 'gap-2']">
      <h2 :class="['text-base', 'font-semibold', 'flex', 'items-baseline', 'gap-2']">
        {{ game.variant.value === 'xiangqi' ? '中国象棋' : 'Chess' }}
        <!-- Which engine Airi is playing with: the server-side native engine
             (Pikafish/Stockfish) or the built-in fallback search. -->
        <span
          v-if="game.engineSource.value"
          :class="[
            'text-xs font-normal px-1.5 py-0.5 rounded',
            game.engineSource.value === 'server'
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300'
              : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
          ]"
        >{{ game.engineSource.value === 'server'
          ? (game.variant.value === 'xiangqi' ? '皮卡鱼引擎' : 'Stockfish 引擎')
          : '内置引擎' }}</span>
      </h2>
      <span :class="['text-sm', 'text-neutral-500', 'dark:text-neutral-400']">{{ game.statusText.value }}</span>
    </div>

    <!-- During a finished review the board shows the viewed snapshot; the check
         glow is suppressed because it belongs to the live final position. -->
    <Board
      :variant="game.variant.value"
      :cols="game.cols.value"
      :rows="game.rows.value"
      :square-at="game.squareAt.value"
      :pieces="review.boardPieces.value ?? game.pieces.value"
      :selected="game.selected.value"
      :targets="game.targets.value"
      :last-move="review.boardPieces.value ? review.boardLastMove.value : game.lastMove.value"
      :in-check="review.boardPieces.value ? false : game.inCheck.value"
      :turn="game.turn.value"
      @square-click="game.onSquareClick"
    />

    <section
      v-if="game.phase.value === 'setup'"
      :class="['w-full', 'max-w-120', 'flex', 'flex-col', 'gap-3', 'p-4', 'rounded-lg', 'bg-white', 'dark:bg-neutral-900', 'ring-1', 'ring-neutral-200', 'dark:ring-neutral-800']"
    >
      <h3 :class="['text-base', 'font-semibold']">
        Match Setup
      </h3>

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
        <span :class="['text-xs', 'uppercase', 'tracking-wide', 'text-neutral-500']">你的水平</span>
        <div :class="['flex', 'gap-2', 'flex-wrap']">
          <button
            v-for="level in LEVELS"
            :key="level.value"
            type="button"
            :class="[
              'px-3 py-1.5 rounded-md text-sm ring-1 ring-neutral-300 dark:ring-neutral-700',
              game.playerLevel.value === level.value ? 'bg-sky-600 text-white ring-sky-600' : 'bg-transparent',
            ]"
            @click="game.playerLevel.value = level.value"
          >
            {{ level.label }}
          </button>
        </div>
        <span :class="['text-xs', 'text-neutral-400', 'mt-0.5']">水平越低，Airi 占优时越会放水让你</span>
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
        {{ game.thinkingLabel.value }}
      </p>
      <button
        type="button"
        :class="['self-start', 'px-3 py-1.5', 'rounded-md', 'text-sm', 'ring-1', 'ring-neutral-300', 'dark:ring-neutral-700']"
        @click="game.restart()"
      >
        New Match
      </button>
    </section>

    <ReviewPanel
      v-if="game.phase.value === 'over'"
      :variant="game.variant.value"
      :status="review.status.value"
      :progress="review.progress.value"
      :error="review.error.value"
      :review="review.review.value"
      :selected-ply="review.selectedPly.value"
      @start="review.start"
      @select="review.select"
    />

    <MoveList
      v-if="game.phase.value !== 'setup'"
      :history="game.history.value"
      :annotations="review.review.value?.plies"
      :active-index="review.selectedPly.value"
      @select="review.select"
    />

    <CoachChat
      v-if="game.mode.value === 'vs-airi' && game.phase.value !== 'setup'"
      :class="['w-full', 'max-w-120']"
      :messages="coach.messages.value"
      :sending="coach.sending.value"
      :voice-enabled="voice.enabled.value"
      :voice-phase="voice.phase.value"
      :voice-error="voice.error.value"
      @ask="coach.ask"
      @toggle-voice="voice.toggle"
    />

    <p v-if="game.errorMessage.value" :class="['w-full', 'max-w-120', 'text-sm', 'text-red-600', 'dark:text-red-400']">
      {{ game.errorMessage.value }}
    </p>
  </div>
</template>
