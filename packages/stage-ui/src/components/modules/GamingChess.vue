<script setup lang="ts">
import { storeToRefs } from 'pinia'

import { useChessStore } from '../../stores/modules/gaming-chess'
import { ChessGame } from '../scenarios/chess'

const chessStore = useChessStore()
const { defaultVariant, defaultLevel, coachPrompt } = storeToRefs(chessStore)
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-4']">
    <!--
      The board runs fully locally (ffish rules + a built-in search). Vs AIRI
      picks its move with the adaptive policy: it eases or plays seriously based
      on the current eval and the player's chosen level.
    -->
    <ChessGame
      :default-variant="defaultVariant"
      :default-level="defaultLevel"
      :coach-prompt="coachPrompt"
    />

    <!-- Coach persona editor: only the persona/instructions; the live position
         (FEN / move history / side to move) is appended automatically at ask
         time, so editing here can't break the board context. -->
    <details
      :class="['w-full', 'max-w-120', 'mx-auto', 'rounded-lg', 'bg-white', 'dark:bg-neutral-900', 'ring-1', 'ring-neutral-200', 'dark:ring-neutral-800', 'p-4']"
    >
      <summary :class="['text-sm', 'font-semibold', 'cursor-pointer', 'select-none']">
        教练设置（提示词）
      </summary>

      <div :class="['mt-3', 'flex', 'flex-col', 'gap-2']">
        <p :class="['text-xs', 'text-neutral-400', 'leading-relaxed']">
          这是教练的「人设 / 指令」。当前局面、走子记录、轮到谁会自动附加，不用你写。
        </p>
        <textarea
          v-model="coachPrompt"
          rows="5"
          :class="[
            'w-full px-3 py-2 rounded-md text-sm leading-relaxed',
            'bg-neutral-100 dark:bg-neutral-800',
            'ring-1 ring-neutral-200 dark:ring-neutral-700',
            'focus:outline-none focus:ring-sky-500',
            'resize-y',
          ]"
        />
        <button
          type="button"
          :class="['self-start', 'px-3 py-1.5', 'rounded-md', 'text-sm', 'ring-1', 'ring-neutral-300', 'dark:ring-neutral-700']"
          @click="chessStore.resetCoachPrompt()"
        >
          恢复默认
        </button>
      </div>
    </details>
  </div>
</template>
