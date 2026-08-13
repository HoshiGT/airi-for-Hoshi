<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'

import type { ChatAssistantMessage, ChatHistoryItem, ContextMessage } from '../../../../types/chat'
import type { ChatToolCallRendererRegistry } from './tool-call-renderer'

import { useVirtualizer } from '@tanstack/vue-virtual'
import { computed, provide, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import HistoryMessageRow from './history-message-row.vue'

import { useChatHistoryScroll } from '../composables/use-chat-history-scroll'
import { chatScrollContainerKey } from '../constants'
import { getChatHistoryItemKey } from '../utils'

const props = withDefaults(defineProps<{
  messages: ChatHistoryItem[]
  streamingMessage?: ChatAssistantMessage & { createdAt?: number }
  sending?: boolean
  assistantLabel?: string
  userLabel?: string
  errorLabel?: string
  retryLabel?: string
  variant?: 'desktop' | 'mobile'
  toolCallRenderers?: ChatToolCallRendererRegistry
}>(), {
  sending: false,
  variant: 'desktop',
  toolCallRenderers: () => ({}),
})

const emit = defineEmits<{
  (e: 'copyMessage', payload: { message: ChatHistoryItem, index: number, key: string | number }): void
  (e: 'deleteMessage', payload: { message: ChatHistoryItem, index: number, key: string | number }): void
  (e: 'retryMessage', payload: { message: ChatHistoryItem, index: number, key: string | number }): void
  (e: 'branchMessage', payload: { message: ChatHistoryItem, index: number, key: string | number }): void
  (e: 'toolCallRerun', payload: { message: ChatHistoryItem, index: number, key: string | number, toolCallId: string, toolName: string, args: string }): void
}>()

// Below this many messages the DOM stays cheap enough that virtual scrolling
// only adds measurement churn without paying rent; beyond it every extra
// message adds one more full MarkdownRenderer subtree.
const MIN_MESSAGES_FOR_VIRTUALIZATION = 40
// Rough per-role height used until a row is actually measured. User bubbles
// are short; assistant replies with tool calls and stickers run long.
const ROW_HEIGHT_ESTIMATE: Record<string, number> = {
  user: 72,
  error: 96,
  assistant: 160,
}
const VIRTUAL_OVERSCAN = 8

const chatHistoryRef = ref<HTMLDivElement>()
provide(chatScrollContainerKey, chatHistoryRef)

const { t } = useI18n()
const labels = computed(() => ({
  assistant: props.assistantLabel ?? t('stage.chat.message.character-name.airi'),
  user: props.userLabel ?? t('stage.chat.message.character-name.you'),
  error: props.errorLabel ?? t('stage.chat.message.character-name.core-system'),
  retry: props.retryLabel ?? t('stage.chat.actions.retry'),
  yesterday: t('stage.chat.message.yesterday'),
}))

const streaming = computed<ChatAssistantMessage & { context?: ContextMessage } & { createdAt?: number }>(() => props.streamingMessage ?? { role: 'assistant', content: '', slices: [], tool_results: [], createdAt: Date.now() })
const streamingTs = computed(() => streaming.value?.createdAt)
const renderMessages = computed<ChatHistoryItem[]>(() => {
  if (!props.sending)
    return props.messages

  const streamTs = streamingTs.value
  if (!streamTs)
    return props.messages

  const hasStreamAlready = streamTs && props.messages.some(msg => msg?.role === 'assistant' && msg?.createdAt === streamTs)
  if (hasStreamAlready)
    return props.messages

  return [...props.messages, streaming.value]
})

const shouldVirtualize = computed(() => renderMessages.value.length > MIN_MESSAGES_FOR_VIRTUALIZATION)

const virtualizer = useVirtualizer(computed(() => ({
  count: renderMessages.value.length,
  getScrollElement: () => chatHistoryRef.value ?? null,
  estimateSize: (index: number) => {
    const role = renderMessages.value[index]?.role
    return (role && ROW_HEIGHT_ESTIMATE[role]) ?? 100
  },
  overscan: VIRTUAL_OVERSCAN,
  getItemKey: (index: number) => getChatHistoryItemKey(renderMessages.value[index], index),
})))

// Vue template refs can also receive component instances; tanstack only cares
// about elements, so filter before delegating to its measureElement.
function measureRow(node: Element | ComponentPublicInstance | null) {
  if (node instanceof Element)
    virtualizer.value.measureElement(node)
}

interface HistoryRow {
  key: string | number
  index: number
  message: ChatHistoryItem
}

// One unified row list for both render modes: the whole history while small,
// the measured window once virtualized. The padding technique below keeps the
// rows in normal document flow (so the flex gap still applies) while the
// container scrolls over the full estimated height.
const rows = computed<HistoryRow[]>(() => {
  if (!shouldVirtualize.value) {
    return renderMessages.value.map((message, index) => ({
      key: getChatHistoryItemKey(message, index),
      index,
      message,
    }))
  }

  return virtualizer.value.getVirtualItems().map(item => ({
    key: String(item.key),
    index: item.index,
    message: renderMessages.value[item.index],
  }))
})

// NOTICE:
// This padding MUST land on the inner list, never on the scroll container.
//
// `clientHeight` includes padding, and tanstack reads the scroll element's
// `clientHeight` as the viewport height. Padding the scroll element itself made
// it report a ~67000px viewport for a window only ~600px tall, so every offset
// tanstack derived was wrong: the rendered window covered most of the history
// and the scroll position no longer tracked the wheel — the list appeared to
// freeze, then jump.
//
// Removal condition: none — the sizer must stay a child of the scroll element.
const listPadding = computed(() => {
  if (!shouldVirtualize.value)
    return undefined

  const items = virtualizer.value.getVirtualItems()
  const lastItem = items[items.length - 1]
  return {
    paddingTop: `${items[0]?.start ?? 0}px`,
    paddingBottom: `${lastItem ? virtualizer.value.getTotalSize() - lastItem.end : 0}px`,
  }
})

useChatHistoryScroll({
  containerRef: chatHistoryRef,
  messages: renderMessages,
  getKey: getChatHistoryItemKey,
  virtualScroll: {
    scrollToMessage: (key) => {
      if (!shouldVirtualize.value)
        return false

      const index = renderMessages.value.findIndex((message, i) => getChatHistoryItemKey(message, i) === key)
      if (index < 0)
        return false

      virtualizer.value.scrollToIndex(index, { align: 'start' })
      return true
    },
    scrollToBottom: () => {
      if (!shouldVirtualize.value)
        return false

      virtualizer.value.scrollToIndex(renderMessages.value.length - 1, { align: 'end' })
      return true
    },
  },
})
</script>

<template>
  <div
    ref="chatHistoryRef"
    :class="['relative h-full w-full overflow-y-auto rounded-xl']"
  >
    <div :class="['flex flex-col', '<sm:px-2 <sm:py-2', variant === 'mobile' ? 'gap-1' : 'gap-2']" :style="listPadding">
      <template v-for="row in rows" :key="row.key">
        <div
          :ref="measureRow"
          :data-index="row.index"
          :data-chat-message-index="row.index"
          :data-chat-message-key="String(row.key)"
          :data-chat-message-role="row.message.role"
        >
          <HistoryMessageRow
            :message="row.message"
            :index="row.index"
            :labels="labels"
            :sending="sending"
            :streaming-ts="streamingTs"
            :prev-role="renderMessages[row.index - 1]?.role ?? null"
            :is-last="row.index === renderMessages.length - 1"
            :variant="variant"
            :tool-call-renderers="toolCallRenderers"
            @copy-message="emit('copyMessage', $event)"
            @delete-message="emit('deleteMessage', $event)"
            @retry-message="emit('retryMessage', $event)"
            @branch-message="emit('branchMessage', $event)"
            @tool-call-rerun="emit('toolCallRerun', $event)"
          />
        </div>
      </template>
    </div>
  </div>
</template>
