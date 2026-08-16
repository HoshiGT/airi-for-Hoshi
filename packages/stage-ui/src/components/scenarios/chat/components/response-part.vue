<script setup lang="ts">
import type { ChatAssistantMessage } from '../../../../types/chat'

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { MarkdownRenderer } from '../../../markdown'

const props = defineProps<{
  message: ChatAssistantMessage
  variant?: 'desktop' | 'mobile'
}>()

const { t } = useI18n()

const reasoningContent = computed(() => props.message.categorization?.reasoning?.trim() ?? '')
const hasReasoning = computed(() => reasoningContent.value.length > 0)

// Thinking is hidden behind a disclosure (Claude-app style): the header stays
// visible whenever reasoning exists, the body reveals on click. Collapsed by
// default so private reasoning never dominates the bubble.
const expanded = ref(false)

const bodyTextSize = computed(() => props.variant === 'mobile' ? 'text-xs' : 'text-sm')
</script>

<template>
  <div v-if="hasReasoning" :class="['flex flex-col gap-1']">
    <button
      type="button"
      :class="[
        'flex items-center gap-1 self-start',
        'text-xs text-neutral-400 dark:text-neutral-500',
        'transition-colors hover:text-neutral-600 dark:hover:text-neutral-300',
      ]"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <div :class="['i-solar:magic-stick-2-bold-duotone', 'text-sm']" />
      <span>{{ t('stage.chat.reasoning') }}</span>
      <div :class="['i-solar:alt-arrow-down-linear', 'text-xs transition-transform', expanded ? 'rotate-180' : '']" />
    </button>
    <MarkdownRenderer
      v-if="expanded"
      :content="reasoningContent"
      :class="[bodyTextSize, 'break-words border-l-2 border-neutral-200 pl-2 dark:border-neutral-700']"
      text="neutral-700/60 dark:neutral-300/60"
    />
  </div>
</template>
