import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { useConfiguratorByModsChannelServer } from '../configurator'

export const useQQStore = defineStore('qq', () => {
  const configurator = useConfiguratorByModsChannelServer()
  const enabled = useLocalStorageManualReset<boolean>('settings/qq/enabled', false)
  const botUin = useLocalStorageManualReset<string>('settings/qq/botUin', '')
  const napCatToken = useLocalStorageManualReset<string>('settings/qq/napCatToken', '')

  function saveSettings() {
    configurator.updateFor('qq', {
      enabled: enabled.value,
      botUin: botUin.value,
      napCatToken: napCatToken.value,
    })
  }

  const configured = computed(() => !!botUin.value.trim())

  function resetState() {
    enabled.reset()
    botUin.reset()
    napCatToken.reset()
    saveSettings()
  }

  return {
    enabled,
    botUin,
    napCatToken,
    configured,
    saveSettings,
    resetState,
  }
})
