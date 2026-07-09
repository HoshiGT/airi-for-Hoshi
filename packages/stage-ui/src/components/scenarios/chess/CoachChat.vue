<script setup lang="ts">
import type { CoachMessage } from './use-chess-coach'
import type { ChessVoicePhase } from './use-chess-voice'

import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps<{
  messages: CoachMessage[]
  sending: boolean
  /** Whether hands-free voice mode is on (shows the mic as active). */
  voiceEnabled?: boolean
  /** Current voice turn-taking phase; drives the status chip. */
  voicePhase?: ChessVoicePhase
  /** Voice error/hint to surface under the input. */
  voiceError?: string
}>()

const emit = defineEmits<{
  (event: 'ask', text: string): void
  (event: 'toggleVoice'): void
}>()

const draft = ref('')
const listEl = ref<HTMLElement>()

function submit() {
  const text = draft.value.trim()
  if (!text || props.sending) {
    return
  }
  emit('ask', text)
  draft.value = ''
}

// Short status shown next to the title while voice mode is on.
const voiceStatusText = computed(() => {
  if (!props.voiceEnabled)
    return '下棋途中随时问'
  switch (props.voicePhase) {
    case 'listening': return '🎤 在听…说话试试'
    case 'thinking': return '✍️ 识别中…'
    case 'speaking': return '🔊 Airi 在说…'
    default: return '语音模式'
  }
})

// Pulse the mic while actively listening so it reads as "hot".
const micButtonClass = computed(() => {
  if (!props.voiceEnabled)
    return ['bg-neutral-100', 'dark:bg-neutral-800', 'text-neutral-500', 'hover:bg-neutral-200', 'dark:hover:bg-neutral-700']
  if (props.voicePhase === 'listening')
    return ['bg-sky-600', 'text-white', 'animate-pulse']
  return ['bg-sky-600', 'text-white']
})

// Keep the latest reply in view as tokens stream in.
watch(
  () => props.messages.map(message => message.content).join('|'),
  async () => {
    await nextTick()
    if (listEl.value) {
      listEl.value.scrollTop = listEl.value.scrollHeight
    }
  },
)
</script>

<template>
  <div
    :class="['w-full', 'flex', 'flex-col', 'gap-2', 'p-3', 'rounded-lg', 'bg-white', 'dark:bg-neutral-900', 'ring-1', 'ring-neutral-200', 'dark:ring-neutral-800']"
  >
    <div :class="['flex', 'items-center', 'gap-2']">
      <span :class="['text-sm', 'font-semibold']">教练 Airi</span>
      <span :class="['text-xs', 'text-neutral-400']">{{ voiceStatusText }}</span>
      <button
        type="button"
        :title="voiceEnabled ? '关闭语音对话' : '开启语音对话（对着麦克风说话）'"
        :aria-pressed="voiceEnabled"
        :class="[
          'ml-auto flex items-center justify-center w-8 h-8 rounded-full transition-colors',
          ...micButtonClass,
        ]"
        @click="emit('toggleVoice')"
      >
        <div :class="[voiceEnabled ? 'i-solar:microphone-bold' : 'i-solar:microphone-line-duotone', 'text-lg']" />
      </button>
    </div>

    <div
      ref="listEl"
      :class="['flex', 'flex-col', 'gap-2', 'max-h-60', 'overflow-y-auto', 'pr-1']"
    >
      <p
        v-if="messages.length === 0"
        :class="['text-xs', 'text-neutral-400', 'leading-relaxed']"
      >
        比如：「这步该怎么走？」「我刚才那步亏不亏？」「现在我该攻还是守？」
      </p>

      <div
        v-for="(message, index) in messages"
        :key="index"
        :class="['flex', message.role === 'user' ? 'justify-end' : 'justify-start']"
      >
        <div
          :class="[
            'max-w-[85%] px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words',
            message.role === 'user'
              ? 'bg-sky-600 text-white rounded-br-sm'
              : 'bg-neutral-100 dark:bg-neutral-800 rounded-bl-sm',
          ]"
        >
          <span v-if="message.content">{{ message.content }}</span>
          <span v-else :class="['text-neutral-400', 'animate-pulse']">思考中…</span>
        </div>
      </div>
    </div>

    <p
      v-if="voiceError"
      :class="['text-xs', 'text-amber-600', 'dark:text-amber-400', 'leading-relaxed']"
    >
      {{ voiceError }}
    </p>

    <form :class="['flex', 'items-center', 'gap-2']" @submit.prevent="submit">
      <input
        v-model="draft"
        type="text"
        placeholder="问问教练…"
        :disabled="sending"
        :class="[
          'flex-1 px-3 py-2 rounded-md text-sm',
          'bg-neutral-100 dark:bg-neutral-800',
          'ring-1 ring-neutral-200 dark:ring-neutral-700',
          'focus:outline-none focus:ring-sky-500',
          'disabled:opacity-60',
        ]"
      >
      <button
        type="submit"
        :disabled="sending || !draft.trim()"
        :class="[
          'px-4 py-2 rounded-md text-sm font-semibold',
          'bg-sky-600 text-white hover:bg-sky-500',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        ]"
      >
        发送
      </button>
    </form>
  </div>
</template>
