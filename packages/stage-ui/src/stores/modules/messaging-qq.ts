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

  /**
   * 让 qq-bot 进程重启它的反向 WS 服务器（NapCat 连接卡死时的兜底）。
   *
   * 模块名必须是 qq-bot 进程 announce 的 name（`proj-airi:qq-bot`），
   * server-runtime 按它把 `ui:configure` 路由成 `module:configure` 直发
   * 该进程；qq-bot 未运行时 server 会回 module-not-found，指令静默丢弃。
   */
  function restartWsServer() {
    configurator.updateFor('proj-airi:qq-bot', { command: 'restart-ws-server' })
  }

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
    restartWsServer,
    resetState,
  }
})
