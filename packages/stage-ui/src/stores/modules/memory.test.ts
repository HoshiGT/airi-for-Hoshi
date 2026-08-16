import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { COMPACTED_CONTEXT_PROMPT, HISTORY_TOOLSET_PROMPT } from '../../tools/history'
import { MEMORY_TOOLSET_PROMPT } from '../../tools/memory'
import { useLlmToolsetPromptsStore } from '../llm-toolset-prompts'
import { useMemoryStore } from './memory'

// The store reads provider metadata for its model picker; none of that is under
// test here, and instantiating the real providers store pulls in every provider
// definition.
vi.mock('../providers', () => ({
  useProvidersStore: () => ({
    getProviderMetadata: () => undefined,
    findProviderMetadata: () => undefined,
    getModelsForProvider: () => [],
    isLoadingModels: {},
    modelLoadError: {},
  }),
}))

/** Ids currently mounted under the memory module's toolset-prompt slot. */
function mountedPromptIds(prompts: ReturnType<typeof useLlmToolsetPromptsStore>): string[] {
  return (prompts.promptsByProvider.memory ?? []).map(prompt => prompt.id)
}

/** Puts the module in the state where its tools (and prompts) mount. */
function configure(store: ReturnType<typeof useMemoryStore>) {
  store.activeProvider = 'some-provider'
  store.activeModel = 'some-model'
  store.toolsEnabled = true
}

describe('useMemoryStore toolset prompts', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('mounts nothing until the module is configured', async () => {
    const prompts = useLlmToolsetPromptsStore()
    const store = useMemoryStore()
    await nextTick()

    expect(store.toolsActive).toBe(false)
    expect(prompts.promptsByProvider.memory).toBeUndefined()
  })

  it('mounts memory and history guidance together once active', async () => {
    const prompts = useLlmToolsetPromptsStore()
    const store = useMemoryStore()
    configure(store)
    await nextTick()

    expect(store.toolsActive).toBe(true)
    expect(mountedPromptIds(prompts)).toEqual(['memory', 'history'])
    expect(prompts.activeToolsetPrompt).toContain(MEMORY_TOOLSET_PROMPT)
    expect(prompts.activeToolsetPrompt).toContain(HISTORY_TOOLSET_PROMPT)
  })

  it('withholds the compacted-context notice while trimming is off', async () => {
    // ROOT CAUSE:
    //
    // The notice tells the model its older rounds are gone. With
    // `trimAfterConsolidation` off, consolidation only distills memories and
    // every round is still in the context — the notice would be false, and the
    // model would go searching for history already in front of it.
    const prompts = useLlmToolsetPromptsStore()
    const store = useMemoryStore()
    configure(store)
    await nextTick()

    expect(store.trimAfterConsolidation).toBe(false)
    expect(mountedPromptIds(prompts)).not.toContain('compacted-context')
    expect(prompts.activeToolsetPrompt).not.toContain(COMPACTED_CONTEXT_PROMPT)
  })

  it('adds the compacted-context notice when trimming is turned on', async () => {
    const prompts = useLlmToolsetPromptsStore()
    const store = useMemoryStore()
    configure(store)
    await nextTick()

    store.trimAfterConsolidation = true
    await nextTick()

    expect(mountedPromptIds(prompts)).toEqual(['memory', 'history', 'compacted-context'])
    expect(prompts.activeToolsetPrompt).toContain(COMPACTED_CONTEXT_PROMPT)
  })

  it('drops the notice again when trimming is turned back off', async () => {
    const prompts = useLlmToolsetPromptsStore()
    const store = useMemoryStore()
    configure(store)
    store.trimAfterConsolidation = true
    await nextTick()

    store.trimAfterConsolidation = false
    await nextTick()

    expect(mountedPromptIds(prompts)).toEqual(['memory', 'history'])
    expect(prompts.activeToolsetPrompt).not.toContain(COMPACTED_CONTEXT_PROMPT)
  })

  it('clears every prompt when the tools are switched off, trimming or not', async () => {
    const prompts = useLlmToolsetPromptsStore()
    const store = useMemoryStore()
    configure(store)
    store.trimAfterConsolidation = true
    await nextTick()

    store.toolsEnabled = false
    await nextTick()

    expect(store.toolsActive).toBe(false)
    expect(prompts.promptsByProvider.memory).toBeUndefined()
  })
})

describe('the compacted-context notice itself', () => {
  it('names the tool that recovers the missing rounds', () => {
    // A notice that history is gone, with no next move, just invites guessing.
    expect(COMPACTED_CONTEXT_PROMPT).toContain('history_search')
  })

  it('tells the model a gap means compaction, not a user misremembering', () => {
    expect(COMPACTED_CONTEXT_PROMPT).toContain('misremembering')
  })
})
