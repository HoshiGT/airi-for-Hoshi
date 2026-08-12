import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { refManualReset } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, watch } from 'vue'

import { COMPACTED_CONTEXT_PROMPT, HISTORY_TOOLSET_PROMPT } from '../../tools/history'
import { MEMORY_TOOLSET_PROMPT } from '../../tools/memory'
import { useLlmToolsetPromptsStore } from '../llm-toolset-prompts'
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
 *
 * Beyond that scheduled pass, the character can also curate memory itself mid-
 * conversation via the `memory_*` tools. This store owns the gate for that
 * ({@link toolsActive}) plus the paired system-prompt guidance, so the model is
 * told about those tools exactly when they are mounted and never otherwise.
 */
export const useMemoryStore = defineStore('memory', () => {
  const providersStore = useProvidersStore()
  const toolsetPromptsStore = useLlmToolsetPromptsStore()

  // Model selection (independent from the core/consciousness model).
  const activeProvider = useLocalStorageManualReset<string>('settings/memory/active-provider', '')
  const activeModel = useLocalStorageManualReset<string>('settings/memory/active-model', '')
  const activeCustomModelName = useLocalStorageManualReset<string>('settings/memory/active-custom-model', '')
  const expandedDescriptions = refManualReset<Record<string, boolean>>(() => ({}))
  const modelSearchQuery = refManualReset<string>('')

  // Consolidation cadence. `triggerRounds` is the high-water mark that starts a
  // consolidation pass; `retainRounds` is how many of the most recent rounds are
  // kept verbatim. The difference is summarized+archived each pass.
  // Defaults pin the live context to 30 rounds: the trigger fires at 30 and the
  // retained window is 30, so every older round is distilled into memory before
  // it leaves the live conversation (2026-08-08 request: 30-round context cap).
  const triggerRounds = useLocalStorageManualReset<number>('settings/memory/trigger-rounds', 30)
  const retainRounds = useLocalStorageManualReset<number>('settings/memory/retain-rounds', 30)

  // Gates daily auto-consolidation: on the first conversation turn each day,
  // all unprocessed rounds (beyond the retained window) are consolidated in one
  // batch instead of firing on every turn once the round count exceeds the
  // threshold. The manual 整理 button ignores this.
  const autoConsolidationEnabled = useLocalStorageManualReset<boolean>('settings/memory/auto-consolidation-enabled', true)

  // ISO date string (YYYY-MM-DD) of the last daily auto-consolidation. Compared
  // against today's date to decide whether the daily pass should fire.
  const lastDailyConsolidationDate = useLocalStorageManualReset<string>('settings/memory/last-daily-consolidation-date', '')

  // Free-form user guidance appended to the consolidation system prompt so the
  // model distills memories according to the user's stated preferences (what to
  // keep, what to ignore, how to weigh importance). Empty = no extra guidance.
  const consolidationPrompt = useLocalStorageManualReset<string>('settings/memory/consolidation-prompt', '')

  // Whether a consolidation pass also removes the rounds it summarized from the
  // live conversation. Default off: keeping old rounds lets Airi search the
  // original messages for context; the archived summaries still exist as a
  // distilled backup. Cost is an unbounded context window — session resume
  // (cache-read 0.1×) absorbs most of the token cost.
  const trimAfterConsolidation = useLocalStorageManualReset<boolean>('settings/memory/trim-after-consolidation', false)

  // Lets the character save/recall/forget memories during a conversation.
  // Default on: once a memory model is configured this is part of having memory
  // at all, not an extra capability to opt into — the switch exists so the user
  // can take the pen back without tearing down the whole module.
  const toolsEnabled = useLocalStorageManualReset<boolean>('settings/memory/tools-enabled', true)

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

  // The `memory_*` tools only touch the local store, so they would technically
  // work with no summarization model. They still ride on `configured`: an
  // unconfigured module means the user has not set memory up at all, and a
  // character that quietly accumulates memories nobody has enabled is worse than
  // one that has none. Relaxing this is a one-line change if standalone in-chat
  // memory (no consolidation) ever becomes a wanted mode.
  const toolsActive = computed(() => toolsEnabled.value && configured.value)

  // Keep the when-to-remember guidance mounted iff the tools are mounted. This
  // must key off the same `toolsActive` gate `resolveMemoryTools` does, never a
  // raw flag read, so the model is never told about tools it cannot call.
  // `trimAfterConsolidation` is watched alongside the gate because the
  // compacted-context notice must appear and disappear with it: mounted while
  // trimming is off it would tell the model its history is gone when every round
  // is still right there.
  watch([toolsActive, trimAfterConsolidation], ([active, trimming]) => {
    if (!active) {
      toolsetPromptsStore.clearToolsetPrompts('memory')
      return
    }

    // All of these ride the one 'memory' owner id so they mount and unmount
    // together: the history guidance is written as a contrast with recall and
    // reads as a dangling reference on its own.
    toolsetPromptsStore.registerToolsetPrompts('memory', [
      { id: 'memory', content: MEMORY_TOOLSET_PROMPT },
      { id: 'history', content: HISTORY_TOOLSET_PROMPT },
      ...(trimming ? [{ id: 'compacted-context', content: COMPACTED_CONTEXT_PROMPT }] : []),
    ])
  }, { immediate: true })

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
    lastDailyConsolidationDate.reset()
    consolidationPrompt.reset()
    trimAfterConsolidation.reset()
    toolsEnabled.reset()
    resetModelSelection()
  }

  return {
    configured,
    toolsEnabled,
    toolsActive,
    activeProvider,
    activeModel,
    customModelName: activeCustomModelName,
    resolvedModel,
    expandedDescriptions,
    modelSearchQuery,

    triggerRounds,
    autoConsolidationEnabled,
    lastDailyConsolidationDate,
    retainRounds,
    consolidationPrompt,
    trimAfterConsolidation,

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
