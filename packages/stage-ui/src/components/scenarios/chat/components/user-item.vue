<script setup lang="ts">
import type { ChatHistoryItem, ChatMessage } from '../../../../types/chat'

import { isStageCapacitor, isStageWeb } from '@proj-airi/stage-shared'
import { computed } from 'vue'

import StickerSlice from './sticker-slice.vue'

import { MarkdownRenderer } from '../../../markdown'
import { ChatActionMenu } from '../components/action-menu'
import { formatChatTimestamp, getChatHistoryItemCopyText } from '../utils'

const props = withDefaults(defineProps<{
  message: Extract<ChatMessage, { role: 'user' }> & { createdAt?: number }
  label: string
  yesterdayLabel?: string
  variant?: 'desktop' | 'mobile'
}>(), {
  yesterdayLabel: 'Yesterday',
  variant: 'desktop',
})

const emit = defineEmits<{
  (e: 'copy'): void
  (e: 'branch'): void
  (e: 'delete'): void
}>()

const content = computed(() => {
  const raw = props.message.content
  if (typeof raw === 'string')
    return raw

  if (Array.isArray(raw)) {
    const textPart = raw.find(part => 'type' in part && part.type === 'text') as { text?: string } | undefined
    if (textPart?.text)
      return textPart.text

    return raw.map(entry => JSON.stringify(entry)).join('\n')
  }

  return ''
})

const imageUrls = computed<string[]>(() => {
  const raw = props.message.content
  if (!Array.isArray(raw))
    return []
  return raw
    .filter((part): part is { type: 'image_url', image_url: { url: string } } =>
      typeof part === 'object' && part !== null && 'type' in part && part.type === 'image_url')
    .map(part => part.image_url.url)
})

interface BubbleSegment { type: 'bubble', text: string }
interface StickerSegment { type: 'sticker', name: string }
type MessageSegment = BubbleSegment | StickerSegment

const STICKER_RE = /<\|STICKER_(.+?)\|>/g

const segments = computed((): MessageSegment[] => {
  const text = content.value
  if (!text)
    return []

  const result: MessageSegment[] = []
  let lastIndex = 0

  for (const match of text.matchAll(STICKER_RE)) {
    const before = text.slice(lastIndex, match.index)
    if (before.trim()) {
      for (const line of before.split('\n').filter(l => l.trim()))
        result.push({ type: 'bubble', text: line })
    }

    const name = match[1].trim()
    if (name)
      result.push({ type: 'sticker', name })

    lastIndex = match.index! + match[0].length
  }

  const after = text.slice(lastIndex)
  if (after.trim()) {
    for (const line of after.split('\n').filter(l => l.trim()))
      result.push({ type: 'bubble', text: line })
  }

  return result
})

const containerClasses = computed(() => [
  'flex',
  props.variant === 'mobile' ? 'ml-0 flex-row' : 'ml-12 flex-row-reverse',
])

const boxClasses = computed(() => [
  props.variant === 'mobile' ? 'px-2 py-2 text-sm bg-neutral-100/90 dark:bg-neutral-800/90' : 'px-3 py-3 bg-neutral-100/80 dark:bg-neutral-800/80',
])
const firstBubbleIdx = computed(() => segments.value.findIndex(s => s.type === 'bubble'))
const hasBubble = computed(() => firstBubbleIdx.value !== -1)
const copyText = computed(() => getChatHistoryItemCopyText(props.message as ChatHistoryItem))
const timeText = computed(() => formatChatTimestamp(props.message.createdAt, { yesterday: props.yesterdayLabel }))
</script>

<template>
  <div v-if="message.role === 'user'" :class="containerClasses" class="ph-no-capture">
    <ChatActionMenu
      :copy-text="copyText"
      placement="left"
      @copy="emit('copy')"
      @branch="emit('branch')"
      @delete="emit('delete')"
    >
      <template #default="{ setMeasuredElement }">
        <div :ref="setMeasuredElement" flex="~ col" gap-1.5>
          <!-- Standalone label for sticker-only messages (no text bubbles) -->
          <div v-if="!hasBubble" :class="['flex items-baseline gap-1.5 <sm:hidden']">
            <span text-sm text="black/60 dark:white/65" font-normal>{{ label }}</span>
            <span v-if="timeText" text-xs text="black/35 dark:white/40" font-normal>{{ timeText }}</span>
          </div>

          <template v-for="(seg, sIdx) in segments" :key="sIdx">
            <StickerSlice
              v-if="seg.type === 'sticker'"
              :name="seg.name"
              :class="['self-end']"
            />
            <div
              v-else
              flex="~ col" shadow="sm neutral-200/50 dark:none"
              min-w-20 rounded-xl h="unset <sm:fit"
              :class="[
                boxClasses,
                (isStageWeb() || isStageCapacitor()) && props.variant === 'mobile' ? 'select-none sm:select-auto' : '',
              ]"
            >
              <div v-if="sIdx === firstBubbleIdx" class="<sm:hidden" :class="['flex items-baseline gap-1.5']">
                <span text-sm text="black/60 dark:white/65" font-normal>{{ label }}</span>
                <span v-if="timeText" text-xs text="black/35 dark:white/40" font-normal>{{ timeText }}</span>
              </div>
              <MarkdownRenderer
                :content="seg.text"
                class="break-words"
              />
            </div>
          </template>

          <!-- Attached image thumbnails -->
          <div v-if="imageUrls.length" :class="['flex flex-wrap gap-1.5 justify-end']">
            <img
              v-for="(url, imgIdx) in imageUrls"
              :key="imgIdx"
              :src="url"
              :class="[
                'rounded-lg object-cover',
                'border border-neutral-200/60 dark:border-neutral-700/60',
              ]"
              :style="{ width: imageUrls.length === 1 ? '12rem' : '6rem', height: imageUrls.length === 1 ? '12rem' : '6rem' }"
            >
          </div>
        </div>
      </template>
    </ChatActionMenu>
  </div>
</template>
