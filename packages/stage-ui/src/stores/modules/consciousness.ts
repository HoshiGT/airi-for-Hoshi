import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { refManualReset } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, watch } from 'vue'

import { useProvidersStore } from '../providers'

export const useConsciousnessStore = defineStore('consciousness', () => {
  const providersStore = useProvidersStore()

  // State
  const activeProvider = useLocalStorageManualReset<string>('settings/consciousness/active-provider', '')
  const activeModel = useLocalStorageManualReset<string>('settings/consciousness/active-model', '')
  const activeCustomModelName = useLocalStorageManualReset<string>('settings/consciousness/active-custom-model', '')
  const expandedDescriptions = refManualReset<Record<string, boolean>>(() => ({}))
  const modelSearchQuery = refManualReset<string>('')

  // Computed properties
  const supportsModelListing = computed(() => {
    return providersStore.findProviderMetadata(activeProvider.value)?.capabilities.listModels !== undefined
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

  function resetModelSelection() {
    activeModel.reset()
    activeCustomModelName.reset()
    expandedDescriptions.reset()
    modelSearchQuery.reset()
  }

  // A model id belongs to the catalog of the provider it was picked from, so
  // clear the selection whenever the provider changes. This used to live only
  // in the consciousness settings page, so provider changes made elsewhere
  // (onboarding, character cards, provider deletion) kept the previous
  // provider's model and chat requests failed upstream with model_not_found.
  //
  // The watcher is synchronous on purpose: call sites assign the provider
  // first and a new model right after (e.g. use-auth-provider-sync), so a
  // deferred reset would wipe the model they just chose. Synchronous flush
  // makes "set provider, then set model" a safe, ordered operation.
  //
  // Issue #1761: https://github.com/moeru-ai/airi/issues/1761
  watch(activeProvider, (provider, oldProvider) => {
    if (provider === oldProvider)
      return

    activeModel.value = ''
    activeCustomModelName.value = ''
  }, { flush: 'sync' })

  async function loadModelsForProvider(provider: string) {
    if (providersStore.findProviderMetadata(provider)?.capabilities.listModels !== undefined) {
      await providersStore.fetchModelsForProvider(provider)
    }
  }

  async function getModelsForProvider(provider: string) {
    if (providersStore.findProviderMetadata(provider)?.capabilities.listModels !== undefined) {
      return providersStore.getModelsForProvider(provider)
    }

    return []
  }

  const configured = computed(() => {
    return !!activeProvider.value && !!activeModel.value
  })

  function resetState() {
    activeProvider.reset()
    resetModelSelection()
  }

  return {
    // State
    configured,
    activeProvider,
    activeModel,
    customModelName: activeCustomModelName,
    expandedDescriptions,
    modelSearchQuery,

    // Computed
    supportsModelListing,
    providerModels,
    isLoadingActiveProviderModels,
    activeProviderModelError,
    filteredModels,

    // Actions
    resetModelSelection,
    loadModelsForProvider,
    getModelsForProvider,
    resetState,
  }
})

/**
 * Resolves the setup error for the selected chat provider and model.
 *
 * Use when:
 * - A chat entry point needs to fail before provider instantiation.
 * - User-facing diagnostics should explain the missing Consciousness selection.
 *
 * Expects:
 * - `providerId` is the current `settings/consciousness/active-provider` value.
 * - `modelId` is the current `settings/consciousness/active-model` value.
 *
 * Returns:
 * - A setup error when no provider or model is selected, otherwise `undefined`.
 */
export function resolveActiveConsciousnessProviderError(providerId: string, modelId: string): string | undefined {
  if (!providerId)
    return 'No active chat provider selected. Select a provider in Settings > Consciousness.'

  // Sending depends on a model as much as on a provider: an empty model fails
  // upstream with model_not_found, so it is the same "module not configured"
  // class and is reported here instead of leaking the provider error.
  if (!modelId.trim())
    return 'No active chat model selected. Select a model in Settings > Consciousness.'

  return undefined
}
