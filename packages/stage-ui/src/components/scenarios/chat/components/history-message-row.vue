<script setup lang="ts">
import type { ChatHistoryItem } from '../../../../types/chat'
import type { ChatToolCallRendererRegistry } from './tool-call-renderer'

import { computed } from 'vue'

import ChatAssistantItem from './assistant-item.vue'
import ChatErrorItem from './error-item.vue'
import ChatUserItem from './user-item.vue'

import { getChatHistoryItemKey } from '../utils'

export interface ChatHistoryRowLabels {
  assistant: string
  user: string
  error: string
  retry: string
  yesterday: string
}

const props = withDefaults(defineProps<{
  message: ChatHistoryItem
  index: number
  labels: ChatHistoryRowLabels
  sending?: boolean
  /**
   * `createdAt` of the message currently being streamed, when one exists.
   * Drives the trailing "still typing" state and the empty-bubble loader.
   */
  streamingTs?: number
  /**
   * Role of the message rendered just above this row, used by the error item
   * to decide whether a retry makes sense.
   */
  prevRole?: string | null
  isLast?: boolean
  variant?: 'desktop' | 'mobile'
  toolCallRenderers?: ChatToolCallRendererRegistry
}>(), {
  sending: false,
  prevRole: null,
  isLast: false,
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

const messageKey = computed(() => getChatHistoryItemKey(props.message, props.index))

const showStreamingPlaceholder = computed(() => {
  const message = props.message
  if (message.role !== 'assistant')
    return false

  return (message.slices?.length ?? 0) === 0 && !message.content
})
const isStreaming = computed(() => {
  const ts = props.streamingTs
  if (ts == null)
    return false

  return props.message.context?.createdAt === ts || props.message.createdAt === ts
})
const showPlaceholder = computed(() => props.sending && isStreaming.value)
const showErrorPlaceholder = computed(() => props.sending && props.isLast)

function emitToolCallRerun(payload: { toolCallId: string, toolName: string, args: string }) {
  emit('toolCallRerun', {
    message: props.message,
    index: props.index,
    key: messageKey.value,
    ...payload,
  })
}

/**
 * Cheap primitive signature for this row's v-memo.
 *
 * v-memo caches are per-directive, which inside a v-for is positional and
 * leaks between iterations when rows shift — so the memo lives here, on the
 * row component's own root, where each message owns one component instance.
 *
 * The streaming message mutates its last text slice in place, so its
 * `last.text` string changes on every token and only that row re-renders;
 * finished messages keep identical primitives and skip their
 * (DOMPurify/Shiki-heavy) subtree entirely.
 */
function getMemo(): unknown[] {
  const message = props.message
  const memo: unknown[] = [
    message.role,
    message.createdAt ?? 0,
    props.labels,
    props.variant,
    props.sending,
    props.prevRole,
    props.isLast,
    props.streamingTs ?? 0,
  ]

  if (message.role === 'error') {
    memo.push(message.content)
    return memo
  }

  const content = message.content
  memo.push(typeof content === 'string' ? content : content?.length ?? 0)

  if (message.role !== 'assistant')
    return memo

  const slices = message.slices ?? []
  memo.push(slices.length, message.tool_results?.length ?? 0)

  const last = slices[slices.length - 1]
  if (last) {
    memo.push(last.type)
    if (last.type === 'text')
      memo.push(last.text)
    else if (last.type === 'tool-call')
      memo.push(last.toolCall.toolCallId, last.toolCall.args)
    else if (last.type === 'sticker')
      memo.push(last.name)
    else
      memo.push(last.id)
  }

  const categorization = message.categorization
  memo.push(typeof categorization?.speech === 'string' ? categorization.speech : 0)
  memo.push(typeof categorization?.reasoning === 'string' ? categorization.reasoning : 0)

  return memo
}
</script>

<template>
  <div v-memo="getMemo()">
    <ChatErrorItem
      v-if="message.role === 'error'"
      :message="message"
      :label="labels.error"
      :retry-label="labels.retry"
      :can-retry="prevRole === 'user'"
      :show-placeholder="showErrorPlaceholder"
      :variant="variant"
      @copy="emit('copyMessage', { message, index, key: messageKey })"
      @retry="emit('retryMessage', { message, index, key: messageKey })"
      @branch="emit('branchMessage', { message, index, key: messageKey })"
      @delete="emit('deleteMessage', { message, index, key: messageKey })"
    />
    <ChatAssistantItem
      v-else-if="message.role === 'assistant'"
      :message="message"
      :label="labels.assistant"
      :yesterday-label="labels.yesterday"
      :show-placeholder="isStreaming && showStreamingPlaceholder"
      :generating="showPlaceholder"
      :variant="variant"
      :tool-call-renderers="toolCallRenderers"
      @copy="emit('copyMessage', { message, index, key: messageKey })"
      @branch="emit('branchMessage', { message, index, key: messageKey })"
      @delete="emit('deleteMessage', { message, index, key: messageKey })"
      @tool-call-rerun="emitToolCallRerun($event)"
    />
    <ChatUserItem
      v-else-if="message.role === 'user'"
      :message="message"
      :label="labels.user"
      :yesterday-label="labels.yesterday"
      :variant="variant"
      @copy="emit('copyMessage', { message, index, key: messageKey })"
      @branch="emit('branchMessage', { message, index, key: messageKey })"
      @delete="emit('deleteMessage', { message, index, key: messageKey })"
    />
  </div>
</template>
