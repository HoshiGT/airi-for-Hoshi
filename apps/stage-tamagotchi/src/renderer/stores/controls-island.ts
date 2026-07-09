import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { watch } from 'vue'

import { electronStageFadeOnHoverChanged, electronStageSetFadeOnHover } from '../../shared/eventa'

export const useControlsIslandStore = defineStore('controls-island', () => {
  // Persist fade-on-hover preference per user
  const fadeOnHoverEnabled = useLocalStorage<boolean>('controls-island/fade-on-hover-enabled', false)
  const dontShowItAgainNoticeFadeOnHover = useLocalStorage<boolean>('preferences/dont-show-it-again/notice/fade-on-hover', false)

  let fadeOnHoverBridgeInitialized = false

  // Mirrors the preference to the main process (tray checkbox) and accepts
  // toggles back from the tray. The tray is the guaranteed escape hatch while
  // fade-on-hover has the stage window in click-through, so the stage window
  // must initialize this bridge before click-through can engage.
  function initializeFadeOnHoverBridge() {
    if (fadeOnHoverBridgeInitialized)
      return

    fadeOnHoverBridgeInitialized = true

    const context = getElectronEventaContext()
    context.on(electronStageSetFadeOnHover, (event) => {
      if (!event?.body)
        return

      fadeOnHoverEnabled.value = !!event.body.enabled
    })

    // immediate: seed the tray with the persisted state on startup
    watch(fadeOnHoverEnabled, (enabled) => {
      context.emit(electronStageFadeOnHoverChanged, { enabled })
    }, { immediate: true })
  }

  function enableFadeOnHover() {
    fadeOnHoverEnabled.value = true
  }

  function disableFadeOnHover() {
    fadeOnHoverEnabled.value = false
  }

  return {
    fadeOnHoverEnabled,
    dontShowItAgainNoticeFadeOnHover,
    enableFadeOnHover,
    disableFadeOnHover,
    initializeFadeOnHoverBridge,
  }
})
