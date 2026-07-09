<script setup lang="ts">
import { useRouter } from 'vue-router'

// NOTICE:
// Upstream shipped this page as a WIP placeholder while the actual memory
// feature (summarization model, cadence, manual consolidation, stored
// memories) lives at /settings/modules/memory. Keeping a dead WIP page next
// to the real module page made "记忆体" vs "记忆" look like two different
// features, so this page forwards to the module page. The settingsEntry meta
// stays so the memory card remains on the settings home screen.
//
// The redirect is done here instead of `redirect:` in the <route> block
// because unplugin-vue-router@0.19.2 never serializes `redirect` into the
// generated route records (verified in
// `node_modules/unplugin-vue-router/dist/options-CAGVi1wo.mjs`: the route
// record generator only emits path/name/component/children/meta/alias/props).
// Removal condition: upstream gives this page real content, or
// unplugin-vue-router supports `redirect` in the route block.
useRouter().replace('/settings/modules/memory')
</script>

<template>
  <div />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.memory.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.memory.description
  icon: i-solar:leaf-bold-duotone
  settingsEntry: true
  order: 5
  stageTransition:
    name: slide
</route>
