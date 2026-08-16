<script setup lang="ts">
import { FieldCheckbox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { reactive, ref, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'

import { useStickersStore } from '../../stores/modules/stickers'

const { t } = useI18n()
const stickersStore = useStickersStore()
// Settings persist to localStorage on change (useLocalStorageManualReset); the
// toolset prompt follows `configured`, so there is no explicit save step.
const { enabled, stickers, visionTaggingAvailable } = storeToRefs(stickersStore)

const fileInput = ref<HTMLInputElement>()
const importing = ref(false)
const previewUrls = reactive<Record<string, string>>({})

// Object URLs resolve asynchronously from IndexedDB; fill the preview map as
// stickers appear. Revocation is owned by the store (removeSticker/resetState).
watchEffect(() => {
  for (const sticker of stickers.value) {
    if (!previewUrls[sticker.id]) {
      void stickersStore.getObjectUrl(sticker.id).then((url) => {
        if (url)
          previewUrls[sticker.id] = url
      })
    }
  }
})

async function onFilesPicked(event: Event) {
  const files = Array.from((event.target as HTMLInputElement).files ?? [])
  if (files.length === 0)
    return

  importing.value = true
  try {
    // Sequential on purpose: each add may run a vision inference, and local
    // models handle one request at a time much better than a burst.
    for (const file of files)
      await stickersStore.addSticker(file)
  }
  finally {
    importing.value = false
    if (fileInput.value)
      fileInput.value.value = ''
  }
}

function onNameChange(id: string, event: Event) {
  stickersStore.updateSticker(id, { name: (event.target as HTMLInputElement).value })
}

function onDescriptionChange(id: string, event: Event) {
  stickersStore.updateSticker(id, { description: (event.target as HTMLInputElement).value })
}
</script>

<template>
  <div flex="~ col gap-6">
    <FieldCheckbox
      v-model="enabled"
      :label="t('settings.pages.modules.stickers.enable')"
      :description="t('settings.pages.modules.stickers.enable-description')"
    />

    <div
      :class="[
        'rounded-lg p-4 text-sm',
        visionTaggingAvailable
          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100'
          : 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100',
      ]"
    >
      {{ visionTaggingAvailable
        ? t('settings.pages.modules.stickers.vision-ready')
        : t('settings.pages.modules.stickers.vision-missing') }}
    </div>

    <div flex="~ row gap-3 items-center">
      <button
        :disabled="importing"
        :class="[
          'rounded-lg px-4 py-2 text-sm',
          'bg-primary-100 text-primary-800 dark:bg-primary-900 dark:text-primary-100',
          'hover:bg-primary-200 dark:hover:bg-primary-800',
          'disabled:cursor-not-allowed disabled:opacity-50',
        ]"
        @click="fileInput?.click()"
      >
        {{ importing
          ? t('settings.pages.modules.stickers.uploading')
          : t('settings.pages.modules.stickers.upload') }}
      </button>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        @change="onFilesPicked"
      >
    </div>

    <div
      v-if="stickers.length === 0"
      :class="['text-sm italic', 'text-neutral-500 dark:text-neutral-400']"
    >
      {{ t('settings.pages.modules.stickers.empty') }}
    </div>

    <div v-else grid="~ cols-1 sm:cols-2 gap-4">
      <div
        v-for="sticker in stickers"
        :key="sticker.id"
        flex="~ row gap-3 items-start"
        :class="['rounded-lg p-3', 'bg-white/60 dark:bg-black/30']"
      >
        <img
          v-if="previewUrls[sticker.id]"
          :src="previewUrls[sticker.id]"
          :alt="sticker.name"
          :class="['h-20 w-20', 'shrink-0 rounded-md object-contain']"
        >
        <div v-else :class="['h-20 w-20', 'shrink-0 rounded-md', 'bg-neutral-200 dark:bg-neutral-800']" />
        <div flex="~ col gap-2" class="min-w-0 flex-1">
          <input
            :value="sticker.name"
            :placeholder="t('settings.pages.modules.stickers.name-placeholder')"
            :class="[
              'w-full rounded-md px-2 py-1 text-sm',
              'bg-neutral-100 dark:bg-neutral-800',
            ]"
            @change="onNameChange(sticker.id, $event)"
          >
          <input
            :value="sticker.description"
            :placeholder="t('settings.pages.modules.stickers.description-placeholder')"
            :class="[
              'w-full rounded-md px-2 py-1 text-xs',
              'bg-neutral-100 dark:bg-neutral-800',
            ]"
            @change="onDescriptionChange(sticker.id, $event)"
          >
          <button
            :class="[
              'self-start text-xs',
              'text-red-500 hover:text-red-600 dark:text-red-400',
            ]"
            @click="stickersStore.removeSticker(sticker.id)"
          >
            {{ t('settings.pages.modules.stickers.delete') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
