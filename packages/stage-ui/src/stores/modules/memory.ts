import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { refManualReset } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { useProvidersStore } from '../providers'

/**
 * Memory module store.
 *
 * Mirrors {@link useConsciousnessStore} for provider/model selection so the
 * summarization/classification model can be chosen independently of the core
 * "consciousness" model, then adds the consolidation cadence knobs.
 *
 * Cadence (user-defined): once the active conversation reaches
 * {@link triggerRounds} rounds, the oldest
 * `triggerRounds - retainRounds` rounds are summarized, classified into
 * long/short-term memory, archived, and trimmed from the active context, while
 * the most recent {@link retainRounds} rounds stay verbatim.
 */
export const useMemoryStore = defineStore('memory', () => {
  const providersStore = useProvidersStore()

  // Model selection (independent from the core/consciousness model).
  const activeProvider = useLocalStorageManualReset<string>('settings/memory/active-provider', '')
  const activeModel = useLocalStorageManualReset<string>('settings/memory/active-model', '')
  const activeCustomModelName = useLocalStorageManualReset<string>('settings/memory/active-custom-model', '')
  const expandedDescriptions = refManualReset<Record<string, boolean>>(() => ({}))
  const modelSearchQuery = refManualReset<string>('')

  // Consolidation cadence. `triggerRounds` is the high-water mark that starts a
  // consolidation pass; `retainRounds` is how many of the most recent rounds are
  // kept verbatim. The difference is summarized+archived each pass.
  const triggerRounds = useLocalStorageManualReset<number>('settings/memory/trigger-rounds', 30)
  const retainRounds = useLocalStorageManualReset<number>('settings/memory/retain-rounds', 10)

  // Gates the automatic round-count-triggered consolidation in the chat
  // orchestrator; the manual 整理 button ignores this. Default off: with
  // large-context brains there is no pressure to trim live history, and
  // auto-trimming surprised the user (2026-07-18 request: manual-only).
  const autoConsolidationEnabled = useLocalStorageManualReset<boolean>('settings/memory/auto-consolidation-enabled', false)

  // Free-form user guidance appended to the consolidation system prompt so the
  // model distills memories according to the user's stated preferences (what to
  // keep, what to ignore, how to weigh importance). Empty = no extra guidance.
  const consolidationPrompt = useLocalStorageManualReset<string>('settings/memory/consolidation-prompt', '')

  const supportsModelListing = computed(() => {
    return providersStore.getProviderMetadata(activeProvider.value)?.capabilities.listModels !== undefined
  })

  const providerModels = computed(() => {
    return providersStore.getModelsForProvider(activeProvider.value)
  })

  const isLoadingActiveProviderModels = computed(() => {
    return providersStore.isLoadingModels[activeProvider.value] || false
  })

  const activeProviderModelError = computed(() => {
    return providersStore.modelLoadError[activeProvider.value] || null
  })

  const filteredModels = computed(() => {
    if (!modelSearchQuery.value.trim()) {
      return providerModels.value
    }

    const query = modelSearchQuery.value.toLowerCase().trim()
    return providerModels.value.filter(model =>
      model.name.toLowerCase().includes(query)
      || model.id.toLowerCase().includes(query)
      || (model.description && model.description.toLowerCase().includes(query)),
    )
  })

  // The model name actually sent to the provider: a free-typed custom id wins
  // over a picked-from-list id so providers without model listing still work.
  const resolvedModel = computed(() => activeCustomModelName.value.trim() || activeModel.value)

  const configured = computed(() => {
    return !!activeProvider.value && !!resolvedModel.value
  })

  function resetModelSelection() {
    activeModel.reset()
    activeCustomModelName.reset()
    expandedDescriptions.reset()
    modelSearchQuery.reset()
  }

  async function loadModelsForProvider(provider: string) {
    if (provider && providersStore.getProviderMetadata(provider)?.capabilities.listModels !== undefined) {
      await providersStore.fetchModelsForProvider(provider)
    }
  }

  async function getModelsForProvider(provider: string) {
    if (provider && providersStore.getProviderMetadata(provider)?.capabilities.listModels !== undefined) {
      return providersStore.getModelsForProvider(provider)
    }

    return []
  }

  function resetState() {
    activeProvider.reset()
    triggerRounds.reset()
    retainRounds.reset()
    autoConsolidationEnabled.reset()
    consolidationPrompt.reset()
    resetModelSelection()
  }

  return {
    configured,
    activeProvider,
    activeModel,
    customModelName: activeCustomModelName,
    resolvedModel,
    expandedDescriptions,
    modelSearchQuery,

    triggerRounds,
    autoConsolidationEnabled,
    retainRounds,
    consolidationPrompt,

    supportsModelListing,
    providerModels,
    isLoadingActiveProviderModels,
    activeProviderModelError,
    filteredModels,

    resetModelSelection,
    loadModelsForProvider,
    getModelsForProvider,
    resetState,
  }
})
