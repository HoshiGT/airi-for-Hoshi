<script setup lang="ts">
import { ref, watchEffect } from 'vue'

import { useStickersStore } from '../../../../stores/modules/stickers'

const emit = defineEmits<{
  (e: 'select', name: string): void
}>()

const stickersStore = useStickersStore()

interface StickerThumb {
  id: string
  name: string
  src?: string
}

const thumbs = ref<StickerThumb[]>([])

watchEffect(async () => {
  const entries: StickerThumb[] = []
  for (const meta of stickersStore.stickers) {
    const src = await stickersStore.getObjectUrl(meta.id)
    entries.push({ id: meta.id, name: meta.name, src })
  }
  thumbs.value = entries
})
</script>

<template>
  <div
    v-if="thumbs.length > 0"
    :class="[
      'grid grid-cols-4 gap-1.5 p-2',
      'max-h-64 overflow-y-auto',
      'scrollbar-thin scrollbar-thumb-neutral-300 dark:scrollbar-thumb-neutral-600',
    ]"
  >
    <button
      v-for="sticker in thumbs"
      :key="sticker.id"
      :title="sticker.name"
      :class="[
        'h-16 w-16 flex items-center justify-center rounded-lg p-1',
        'transition-all duration-150 active:scale-90',
        'hover:bg-primary-100/60 dark:hover:bg-primary-800/40',
      ]"
      @click="emit('select', sticker.name)"
    >
      <img
        v-if="sticker.src"
        :src="sticker.src"
        :alt="sticker.name"
        :class="['max-h-full max-w-full object-contain']"
      >
      <span v-else :class="['text-xs text-neutral-400 italic']">{{ sticker.name }}</span>
    </button>
  </div>
  <div
    v-else
    :class="['p-4 text-center text-sm text-neutral-400']"
  >
    No stickers yet
  </div>
</template>
