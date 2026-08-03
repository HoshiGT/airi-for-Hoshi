<script setup lang="ts">
import type { ChatAssistantMessage, ChatHistoryItem, ChatSlices, ChatSlicesText, ChatSlicesToolCallResult } from '../../../../types/chat'
import type { ChatToolCallRendererRegistry } from './tool-call-renderer'

import { isStageCapacitor, isStageWeb } from '@proj-airi/stage-shared'
import { computed } from 'vue'

import ChatResponsePart from './response-part.vue'
import StickerSlice from './sticker-slice.vue'
import ChatToolCallBlock from './tool-call-block.vue'

import { MarkdownRenderer } from '../../../markdown'
import { formatChatTimestamp, getChatHistoryItemCopyText } from '../utils'
import { ChatActionMenu } from './action-menu'
import { createToolCallResultLookup, resolveToolCallBlockState } from './tool-call-results'

const props = withDefaults(defineProps<{
  message: ChatAssistantMessage & { createdAt?: number }
  label: string
  yesterdayLabel?: string
  showPlaceholder?: boolean
  /**
   * This is the message currently being streamed. Drives the trailing
   * "still typing" dots after already-streamed content — distinct from
   * {@link showPlaceholder}, which is the empty-bubble loader before any
   * content arrives.
   */
  generating?: boolean
  variant?: 'desktop' | 'mobile'
  toolCallRenderers?: ChatToolCallRendererRegistry
}>(), {
  yesterdayLabel: 'Yesterday',
  showPlaceholder: false,
  generating: false,
  variant: 'desktop',
  toolCallRenderers: () => ({}),
})

const emit = defineEmits<{
  (e: 'copy'): void
  (e: 'branch'): void
  (e: 'delete'): void
  (e: 'toolCallRerun', payload: { toolCallId: string, toolName: string, args: string }): void
}>()

const resolvedSlices = computed<ChatSlices[]>(() => {
  if (props.message.slices?.length) {
    return props.message.slices
  }

  if (typeof props.message.content === 'string' && props.message.content.trim()) {
    return [{ type: 'text', text: props.message.content } satisfies ChatSlicesText]
  }

  if (Array.isArray(props.message.content)) {
    const textPart = props.message.content.find(part => 'type' in part && part.type === 'text') as { text?: string } | undefined
    if (textPart?.text)
      return [{ type: 'text', text: textPart.text } satisfies ChatSlicesText]
  }

  return []
})

// Stickers render as their own standalone bubbles (QQ-style), so split them out
// of the text/tool bubble. Everything else (text, tool calls, tool results)
// stays in the main bubble.
const bubbleSlices = computed<ChatSlices[]>(() => resolvedSlices.value.filter(slice => slice.type !== 'sticker'))
const stickerSlices = computed(() => resolvedSlices.value.filter((slice): slice is Extract<ChatSlices, { type: 'sticker' }> => slice.type === 'sticker'))

const toolResultById = computed(() => {
  return createToolCallResultLookup(resolvedSlices.value, props.message.tool_results)
})

function getToolCallResult(slice: ChatSlices): ChatSlicesToolCallResult | undefined {
  if (slice.type !== 'tool-call') {
    return undefined
  }

  return toolResultById.value.get(slice.toolCall.toolCallId)
}

function getToolCallState(slice: ChatSlices): 'executing' | 'done' | 'error' {
  return resolveToolCallBlockState(getToolCallResult(slice))
}

function getToolCallRenderer(slice: ChatSlices) {
  if (slice.type !== 'tool-call') {
    return ChatToolCallBlock
  }

  return props.toolCallRenderers[slice.toolCall.toolName] ?? ChatToolCallBlock
}

// Empty-bubble loader: nothing has streamed yet. Once any content arrives the
// trailing `generating` dots take over instead.
const showLoader = computed(() => props.showPlaceholder && resolvedSlices.value.length === 0)
// The text/tool bubble is shown only when it has content or is loading — a
// sticker-only message renders just the standalone sticker, no empty bubble.
const showBubble = computed(() => bubbleSlices.value.length > 0 || showLoader.value)
const containerClass = computed(() => props.variant === 'mobile' ? 'mr-0' : 'mr-12')
const boxClasses = computed(() => [
  props.variant === 'mobile' ? 'px-2 py-2 text-sm bg-primary-50/90 dark:bg-primary-950/90' : 'px-3 py-3 bg-primary-50/80 dark:bg-primary-950/80',
])
const copyText = computed(() => getChatHistoryItemCopyText(props.message as ChatHistoryItem))
const timeText = computed(() => formatChatTimestamp(props.message.createdAt, { yesterday: props.yesterdayLabel }))
</script>

<template>
  <div flex="~ col" gap-2 :class="containerClass" class="ph-no-capture">
    <ChatActionMenu
      v-if="showBubble"
      :copy-text="copyText"
      :can-delete="!showPlaceholder"
      :can-branch="!showPlaceholder"
      @copy="emit('copy')"
      @branch="emit('branch')"
      @delete="emit('delete')"
    >
      <template #default="{ setMeasuredElement }">
        <div
          :ref="setMeasuredElement"
          flex="~ col" shadow="sm primary-200/50 dark:none"
          min-w-20 gap-2 rounded-xl h="unset <sm:fit"
          :class="[
            boxClasses,
            (isStageWeb() || isStageCapacitor()) && props.variant === 'mobile' ? 'select-none sm:select-auto' : '',
          ]"
        >
          <ChatResponsePart
            v-if="message.categorization"
            :message="message"
            :variant="variant"
          />
          <div class="<sm:hidden" :class="['flex items-baseline gap-1.5']">
            <span text-sm text="black/60 dark:white/65" font-normal>{{ label }}</span>
            <span v-if="timeText" text-xs text="black/35 dark:white/40" font-normal>{{ timeText }}</span>
          </div>
          <div v-if="bubbleSlices.length > 0" class="flex flex-col gap-2 break-words" text="primary-700 dark:primary-100">
            <template v-for="(slice, sliceIndex) in bubbleSlices" :key="sliceIndex">
              <component
                :is="getToolCallRenderer(slice)"
                v-if="slice.type === 'tool-call'"
                :tool-call-id="slice.toolCall.toolCallId"
                :tool-name="slice.toolCall.toolName"
                :args="slice.toolCall.args"
                :state="getToolCallState(slice)"
                :result="getToolCallResult(slice)?.result"
                @tool-call-rerun="emit('toolCallRerun', $event)"
              />
              <template v-else-if="slice.type === 'tool-call-result'" />
              <template v-else-if="slice.type === 'text'">
                <MarkdownRenderer :content="slice.text" />
              </template>
            </template>
            <!-- Trailing "still typing" dots while this message keeps streaming. -->
            <div v-if="generating" class="self-start opacity-60" i-eos-icons:three-dots-loading />
          </div>
          <div v-else-if="showLoader" i-eos-icons:three-dots-loading />
        </div>
      </template>
    </ChatActionMenu>

    <!-- Stickers stand on their own, image-only, like a QQ sticker message. -->
    <StickerSlice
      v-for="(slice, stickerIndex) in stickerSlices"
      :key="`sticker-${stickerIndex}`"
      :name="slice.name"
    />
  </div>
</template>
