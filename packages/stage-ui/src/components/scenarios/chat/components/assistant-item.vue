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

// --- Segments: interleave text bubbles and stickers (QQ-style) ---
//
// Instead of rendering all stickers after the text bubble, we preserve
// the original slice order: text -> sticker -> text becomes three
// separate visual segments. Pure-text bubbles are further split on
// paragraph breaks (\n\n) so each paragraph renders as its own bubble,
// mimicking QQ/WeChat message style.

interface BubbleSegment { type: 'bubble', slices: ChatSlices[] }
interface StickerSegment { type: 'sticker', name: string }
type MessageSegment = BubbleSegment | StickerSegment

/**
 * Splits text on blank-line paragraph boundaries, preserving content
 * inside fenced code blocks (triple backticks) from being split.
 */
function splitIntoBubbles(text: string): string[] {
  const lines = text.split('\n')
  const parts: string[] = []
  let current: string[] = []
  let inFence = false

  for (const line of lines) {
    if (/^`{3,}/.test(line.trimStart()))
      inFence = !inFence

    if (!inFence && line.trim() === '') {
      if (current.length > 0) {
        parts.push(current.join('\n'))
        current = []
      }
      continue
    }

    current.push(line)
  }

  if (current.length > 0)
    parts.push(current.join('\n'))

  return parts
}

const segments = computed<MessageSegment[]>(() => {
  // Step 1: split on sticker boundaries
  const raw: MessageSegment[] = []
  let currentSlices: ChatSlices[] = []

  for (const slice of resolvedSlices.value) {
    if (slice.type === 'sticker') {
      if (currentSlices.length > 0) {
        raw.push({ type: 'bubble', slices: [...currentSlices] })
        currentSlices = []
      }
      raw.push({ type: 'sticker', name: slice.name })
    }
    else {
      currentSlices.push(slice)
    }
  }
  if (currentSlices.length > 0) {
    raw.push({ type: 'bubble', slices: currentSlices })
  }

  // Step 2: split text runs inside bubbles on paragraph breaks (QQ-style
  // multi-bubble). Tool-call slices stay as-is; consecutive text slices
  // are merged and then split on blank-line boundaries so each paragraph
  // becomes its own bubble.
  // Skipped while actively streaming to avoid DOM churn on every token —
  // the multi-bubble "snap" happens once the response finishes, which
  // also acts as a visual cue that the message is complete.
  if (props.generating)
    return raw

  const result: MessageSegment[] = []
  for (const seg of raw) {
    if (seg.type !== 'bubble') {
      result.push(seg)
      continue
    }

    // Walk through the slices, splitting consecutive text runs into
    // paragraph bubbles and emitting non-text slices (tool-call etc.)
    // as their own single-slice bubbles so they don't block splitting.
    let textAccum: string[] = []

    function flushText() {
      if (textAccum.length === 0)
        return
      const combined = textAccum.join('')
      textAccum = []
      const parts = splitIntoBubbles(combined)
      for (const part of parts)
        result.push({ type: 'bubble', slices: [{ type: 'text', text: part }] })
    }

    for (const slice of seg.slices) {
      if (slice.type === 'text') {
        textAccum.push(slice.text)
      }
      else {
        flushText()
        result.push({ type: 'bubble', slices: [slice] })
      }
    }
    flushText()
  }

  return result
})

const firstBubbleIndex = computed(() => segments.value.findIndex(s => s.type === 'bubble'))
const lastBubbleIndex = computed(() => {
  for (let i = segments.value.length - 1; i >= 0; i--) {
    if (segments.value[i].type === 'bubble')
      return i
  }
  return -1
})

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

const showLoader = computed(() => props.showPlaceholder && resolvedSlices.value.length === 0)
const hasContent = computed(() => segments.value.length > 0 || showLoader.value)
const containerClass = computed(() => props.variant === 'mobile' ? 'mr-0' : 'mr-12')
const boxClasses = computed(() => [
  props.variant === 'mobile' ? 'px-2 py-2 text-sm bg-primary-50/90 dark:bg-primary-950/90' : 'px-3 py-3 bg-primary-50/80 dark:bg-primary-950/80',
])
const mobileSelectClass = computed(() =>
  (isStageWeb() || isStageCapacitor()) && props.variant === 'mobile' ? 'select-none sm:select-auto' : '',
)
const copyText = computed(() => getChatHistoryItemCopyText(props.message as ChatHistoryItem))
const timeText = computed(() => formatChatTimestamp(props.message.createdAt, { yesterday: props.yesterdayLabel }))
</script>

<template>
  <div flex="~ col" gap-2 :class="containerClass" class="ph-no-capture">
    <ChatActionMenu
      v-if="hasContent"
      :copy-text="copyText"
      :can-delete="!showPlaceholder"
      :can-branch="!showPlaceholder"
      @copy="emit('copy')"
      @branch="emit('branch')"
      @delete="emit('delete')"
    >
      <template #default="{ setMeasuredElement }">
        <div :ref="setMeasuredElement" flex="~ col" gap-1.5>
          <template v-for="(segment, segIdx) in segments" :key="segIdx">
            <!-- Text/tool bubble -->
            <div
              v-if="segment.type === 'bubble'"
              flex="~ col" shadow="sm primary-200/50 dark:none"
              min-w-20 gap-2 rounded-xl h="unset <sm:fit"
              :class="[boxClasses, mobileSelectClass]"
            >
              <ChatResponsePart
                v-if="firstBubbleIndex === segIdx && message.categorization"
                :message="message"
                :variant="variant"
              />
              <div
                v-if="firstBubbleIndex === segIdx"
                class="<sm:hidden"
                :class="['flex items-baseline gap-1.5']"
              >
                <span text-sm text="black/60 dark:white/65" font-normal>{{ label }}</span>
                <span v-if="timeText" text-xs text="black/35 dark:white/40" font-normal>{{ timeText }}</span>
              </div>
              <div class="flex flex-col gap-2 break-words" text="primary-700 dark:primary-100">
                <template v-for="(slice, si) in segment.slices" :key="si">
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
                <div v-if="generating && lastBubbleIndex === segIdx" class="self-start opacity-60" i-eos-icons:three-dots-loading />
              </div>
            </div>
            <!-- Sticker (standalone, QQ-style) -->
            <StickerSlice
              v-else-if="segment.type === 'sticker'"
              :name="segment.name"
            />
          </template>

          <!-- Generating dots when the last segment is a sticker (no bubble to attach to) -->
          <div
            v-if="generating && !showLoader && segments.length > 0 && segments[segments.length - 1].type !== 'bubble'"
            flex="~ col" shadow="sm primary-200/50 dark:none"
            min-w-20 rounded-xl h="unset <sm:fit"
            :class="boxClasses"
          >
            <div class="self-start opacity-60" i-eos-icons:three-dots-loading />
          </div>

          <!-- Empty-bubble loader before any content arrives -->
          <div
            v-if="showLoader"
            flex="~ col" shadow="sm primary-200/50 dark:none"
            min-w-20 rounded-xl h="unset <sm:fit"
            :class="boxClasses"
          >
            <div i-eos-icons:three-dots-loading />
          </div>
        </div>
      </template>
    </ChatActionMenu>
  </div>
</template>
