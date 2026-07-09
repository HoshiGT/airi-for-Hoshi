<script setup lang="ts">
import { Alert } from '@proj-airi/stage-ui/components'
import { useDesktopControlStore } from '@proj-airi/stage-ui/stores/modules/desktop-control'
import { FieldCheckbox } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'

const { t } = useI18n()

const desktopControlStore = useDesktopControlStore()
const { enabled, mouseEnabled, keyboardEnabled, availability } = storeToRefs(desktopControlStore)

// Three states drive the backend banner: no Electron host at all (web build,
// availability never populated), a host that cannot synthesize input (missing
// xdotool), and a ready backend.
const backendState = computed<'desktop-only' | 'unavailable' | 'ready'>(() => {
  if (!availability.value)
    return 'desktop-only'
  if (!availability.value.input)
    return 'unavailable'
  return 'ready'
})
</script>

<template>
  <div flex="~ col gap-6" class="w-full md:w-[60%]">
    <div bg="neutral-100 dark:[rgba(0,0,0,0.3)]" rounded-xl p-4 flex="~ col gap-4">
      <FieldCheckbox
        v-model="enabled"
        :label="t('settings.pages.modules.desktop-control.enable.label')"
        :description="t('settings.pages.modules.desktop-control.enable.description')"
      />

      <template v-if="enabled">
        <FieldCheckbox
          v-model="mouseEnabled"
          :label="t('settings.pages.modules.desktop-control.mouse.label')"
          :description="t('settings.pages.modules.desktop-control.mouse.description')"
        />
        <FieldCheckbox
          v-model="keyboardEnabled"
          :label="t('settings.pages.modules.desktop-control.keyboard.label')"
          :description="t('settings.pages.modules.desktop-control.keyboard.description')"
        />
      </template>
    </div>

    <Alert v-if="backendState === 'ready'" type="success">
      <template #title>
        {{ t('settings.pages.modules.desktop-control.status.title') }}
      </template>
      <template #content>
        {{ t('settings.pages.modules.desktop-control.status.ready', { backend: availability?.backend }) }}
      </template>
    </Alert>

    <Alert v-else-if="backendState === 'unavailable'" type="warning">
      <template #title>
        {{ t('settings.pages.modules.desktop-control.status.unavailable') }}
      </template>
      <template #content>
        {{ availability?.reason }}
      </template>
    </Alert>

    <Alert v-else type="info">
      <template #content>
        {{ t('settings.pages.modules.desktop-control.status.desktop-only') }}
      </template>
    </Alert>

    <Alert type="info">
      <template #content>
        <RouterLink to="/settings/modules/vision" class="underline">
          {{ t('settings.pages.modules.desktop-control.vision-hint') }}
        </RouterLink>
      </template>
    </Alert>

    <Alert v-if="enabled" type="warning">
      <template #content>
        {{ t('settings.pages.modules.desktop-control.safety') }}
      </template>
    </Alert>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.desktop-control.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
