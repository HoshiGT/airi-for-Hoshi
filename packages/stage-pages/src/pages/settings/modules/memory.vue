<script setup lang="ts">
import { MemorySettingsPanel } from '@proj-airi/stage-ui/components'
</script>

<template>
  <MemorySettingsPanel />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.memory.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
</route>
