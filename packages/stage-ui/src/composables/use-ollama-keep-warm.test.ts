import type { EffectScope } from 'vue'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, reactive } from 'vue'

const warmUpOllamaModel = vi.fn<(baseUrl: string, model: string) => Promise<void>>(() => Promise.resolve())
const getProviderConfig = vi.fn<(id: string) => Record<string, unknown> | undefined>(
  () => ({ baseUrl: 'http://localhost:11434/v1/' }),
)

// Reassigned per test so each case starts from a clean, reactive brain config;
// the mock factory reads it lazily (at `useConsciousnessStore()` call time).
let consciousness: { activeProvider: string, activeModel: string, customModelName: string }

vi.mock('../libs/providers/providers/ollama', () => ({ warmUpOllamaModel }))
vi.mock('../stores/modules/consciousness', () => ({ useConsciousnessStore: () => consciousness }))
vi.mock('../stores/providers', () => ({ useProvidersStore: () => ({ getProviderConfig }) }))

const { useOllamaKeepWarm } = await import('./use-ollama-keep-warm')

const HEARTBEAT_MS = 4 * 60 * 1000

describe('useOllamaKeepWarm', () => {
  let scope: EffectScope

  beforeEach(() => {
    vi.useFakeTimers()
    consciousness = reactive({ activeProvider: '', activeModel: '', customModelName: '' })
    warmUpOllamaModel.mockClear()
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
  })

  it('warms the model immediately when Ollama is the active brain', async () => {
    consciousness.activeProvider = 'ollama'
    consciousness.activeModel = 'qwythos-nothink:latest'

    scope.run(() => useOllamaKeepWarm())
    await vi.advanceTimersByTimeAsync(0)

    expect(warmUpOllamaModel).toHaveBeenCalledTimes(1)
    expect(warmUpOllamaModel).toHaveBeenCalledWith('http://localhost:11434/v1/', 'qwythos-nothink:latest')
  })

  it('re-warms on the heartbeat so the model never idles out', async () => {
    consciousness.activeProvider = 'ollama'
    consciousness.activeModel = 'qwythos-nothink:latest'

    scope.run(() => useOllamaKeepWarm())
    await vi.advanceTimersByTimeAsync(0)
    expect(warmUpOllamaModel).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(warmUpOllamaModel).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
    expect(warmUpOllamaModel).toHaveBeenCalledTimes(3)
  })

  it('does nothing when the brain is not on Ollama', async () => {
    consciousness.activeProvider = 'openai'
    consciousness.activeModel = 'gpt-4o'

    scope.run(() => useOllamaKeepWarm())
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)

    expect(warmUpOllamaModel).not.toHaveBeenCalled()
  })

  it('prefers a manually typed custom model name over the picked one', async () => {
    consciousness.activeProvider = 'ollama'
    consciousness.activeModel = 'picked:latest'
    consciousness.customModelName = 'my-custom:tag'

    scope.run(() => useOllamaKeepWarm())
    await vi.advanceTimersByTimeAsync(0)

    expect(warmUpOllamaModel).toHaveBeenCalledWith('http://localhost:11434/v1/', 'my-custom:tag')
  })

  it('stops the heartbeat when the brain switches away from Ollama', async () => {
    consciousness.activeProvider = 'ollama'
    consciousness.activeModel = 'qwythos-nothink:latest'

    scope.run(() => useOllamaKeepWarm())
    await vi.advanceTimersByTimeAsync(0)
    expect(warmUpOllamaModel).toHaveBeenCalledTimes(1)

    // Switch the brain off Ollama — the reactive watch should pause the heartbeat.
    consciousness.activeProvider = 'openai'
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2)

    expect(warmUpOllamaModel).toHaveBeenCalledTimes(1)
  })

  it('falls back to the default base URL when Ollama has no configured one', async () => {
    getProviderConfig.mockReturnValueOnce(undefined)
    consciousness.activeProvider = 'ollama'
    consciousness.activeModel = 'qwythos-nothink:latest'

    scope.run(() => useOllamaKeepWarm())
    await vi.advanceTimersByTimeAsync(0)

    expect(warmUpOllamaModel).toHaveBeenCalledWith('http://localhost:11434/v1/', 'qwythos-nothink:latest')
  })
})
