<script setup lang="ts">
import { ref, watchEffect } from 'vue'

import { useStickersStore } from '../../../../stores/modules/stickers'

const props = defineProps<{
  name: string
}>()

const stickersStore = useStickersStore()
const src = ref<string>()

// The slice persists only the marker name; resolve the image lazily from the
// sticker library. A deleted/renamed sticker degrades to the name chip below
// instead of a broken image.
watchEffect(async () => {
  const meta = stickersStore.findByName(props.name)
  src.value = meta ? await stickersStore.getObjectUrl(meta.id) : undefined
})
</script>

<template>
  <img
    v-if="src"
    :src="src"
    :alt="name"
    :title="name"
    :class="['max-h-32 max-w-40', 'self-start rounded-lg object-contain']"
  >
  <span
    v-else
    :class="['self-start text-xs italic', 'opacity-60']"
  >[{{ name }}]</span>
</template>
