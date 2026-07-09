<script setup lang="ts">
import { GamingChess } from '@proj-airi/stage-ui/components'
</script>

<template>
  <GamingChess />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.gaming-chess.title
  subtitleKey: settings.title
  stageTransition:
    name: slide
    pageSpecificAvailable: true
</route>
