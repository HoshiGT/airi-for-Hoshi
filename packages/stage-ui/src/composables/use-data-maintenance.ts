import type { ChatSessionsExport } from '../types/chat-session'

import { isStageTamagotchi } from '@proj-airi/stage-shared'
import { useLive2dParams, useSettingsLive2d } from '@proj-airi/stage-ui-live2d'
import { useModelStore } from '@proj-airi/stage-ui-three'

import { useChatOrchestratorStore } from '../stores/chat'
import { useMemoryService } from '../stores/chat/memory'
import { useChatSessionStore } from '../stores/chat/session-store'
import { useDisplayModelsStore } from '../stores/display-models'
import { useMcpStore } from '../stores/mcp'
import { useAiriCardStore } from '../stores/modules/airi-card'
import { useConsciousnessStore } from '../stores/modules/consciousness'
import { useDiscordStore } from '../stores/modules/discord'
import { useFactorioStore } from '../stores/modules/gaming-factorio'
import { useMinecraftStore } from '../stores/modules/gaming-minecraft'
import { useHearingStore } from '../stores/modules/hearing'
import { useSpeechStore } from '../stores/modules/speech'
import { useStickersStore } from '../stores/modules/stickers'
import { useTwitterStore } from '../stores/modules/twitter'
import { useWebSearchStore } from '../stores/modules/web-search'
import { useOnboardingStore } from '../stores/onboarding'
import { useProvidersStore } from '../stores/providers'
import { useSettings, useSettingsAudioDevice } from '../stores/settings'

export function useDataMaintenance() {
  const chatStore = useChatSessionStore()
  const chatOrchestrator = useChatOrchestratorStore()
  const displayModelsStore = useDisplayModelsStore()
  const providersStore = useProvidersStore()
  const settingsStore = useSettings()
  const audioSettingsStore = useSettingsAudioDevice()
  const live2dParamsStore = useLive2dParams()
  const live2dSettingsStore = useSettingsLive2d()
  const threeStore = useModelStore()
  const hearingStore = useHearingStore()
  const speechStore = useSpeechStore()
  const consciousnessStore = useConsciousnessStore()
  const twitterStore = useTwitterStore()
  const webSearchStore = useWebSearchStore()
  const stickersStore = useStickersStore()
  const discordStore = useDiscordStore()
  const factorioStore = useFactorioStore()
  const minecraftStore = useMinecraftStore()
  const mcpStore = useMcpStore()
  const onboardingStore = useOnboardingStore()
  const airiCardStore = useAiriCardStore()
  const memoryService = useMemoryService()

  async function deleteAllModels() {
    await displayModelsStore.resetDisplayModels()
    settingsStore.stageModelSelected = 'preset-live2d-1'
    await settingsStore.updateStageModel()
  }

  async function resetProvidersSettings() {
    await providersStore.resetProviderSettings()
  }

  function resetModulesSettings() {
    hearingStore.resetState()
    speechStore.resetState()
    consciousnessStore.resetState()
    twitterStore.resetState()
    webSearchStore.resetState()
    discordStore.resetState()
    factorioStore.resetState()
    minecraftStore.resetState()
    // async because it also clears the sticker image blobs in IndexedDB;
    // fire-and-forget keeps this reset entrypoint synchronous like the rest.
    void stickersStore.resetState()
  }

  function deleteAllChatSessions() {
    chatOrchestrator.cancelPendingSends()
    chatStore.resetAllSessions()
  }

  async function exportChatSessions() {
    const data = await chatStore.exportSessions()
    const payload: ChatSessionsExport = {
      ...data,
      cards: airiCardStore.exportCards(),
      activeCardId: airiCardStore.activeCardId,
      memory: await memoryService.exportMemory(),
    }
    return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  }

  function isChatSessionsPayload(payload: unknown): payload is ChatSessionsExport {
    if (!payload || typeof payload !== 'object')
      return false
    return (payload as { format?: string }).format === 'chat-sessions-index:v1'
  }

  async function importChatSessions(payload: Record<string, unknown>) {
    if (!isChatSessionsPayload(payload))
      throw new Error('Invalid chat session export format')

    // Cards must land before sessions: importSessions keeps a session's card
    // linkage only when `cards.has(characterId)` — otherwise it re-homes the
    // bucket onto the current card.
    if (payload.cards)
      airiCardStore.importCards(payload.cards)

    await chatStore.importSessions(payload)

    if (payload.memory)
      await memoryService.importMemory(payload.memory)

    // Switch to the exporter's active card LAST, after importSessions has
    // persisted the new index and broadcast the sessions-rewritten
    // invalidation: the activeCardId watcher then lands on the imported
    // bucket's active session (in other windows too, via localStorage sync
    // arriving after the rehydrate broadcast). Switching earlier would let
    // the watcher's ensure run against the pre-import index.
    if (payload.activeCardId && payload.activeCardId !== airiCardStore.activeCardId && airiCardStore.cards.has(payload.activeCardId))
      airiCardStore.activeCardId = payload.activeCardId

    return payload
  }

  async function resetSettingsState() {
    await settingsStore.resetState()
    audioSettingsStore.resetState()
    live2dParamsStore.resetState()
    live2dSettingsStore.resetState()
    threeStore.resetModelStore()
    mcpStore.resetState()
    onboardingStore.resetSetupState()
    airiCardStore.resetState()
  }

  async function deleteAllData() {
    await deleteAllModels()
    await resetProvidersSettings()
    resetModulesSettings()
    deleteAllChatSessions()
    await resetSettingsState()
  }

  async function resetDesktopApplicationState() {
    if (!isStageTamagotchi())
      return

    await resetSettingsState()
    resetModulesSettings()
  }

  return {
    deleteAllModels,
    resetProvidersSettings,
    resetModulesSettings,
    deleteAllChatSessions,
    exportChatSessions,
    importChatSessions,
    deleteAllData,
    resetDesktopApplicationState,
  }
}
