import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProvidersStore } from '../providers'
import { resolveActiveConsciousnessProviderError, useConsciousnessStore } from './consciousness'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    locale: { value: 'en-US' },
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

describe('consciousness store provider selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  // ROOT CAUSE:
  //
  // supportsModelListing called providersStore.getProviderMetadata(...) with
  // `?.` as if it returned undefined for unknown ids, but the function throws.
  // With no provider selected yet (fresh install or reset state persists ''),
  // evaluating the computed surfaced a raw "Provider metadata for  not found"
  // error to the user.
  //
  // We fixed this by adding a non-throwing findProviderMetadata lookup and
  // using it in the capability computeds of the consciousness, speech, and
  // hearing modules.
  //
  // https://github.com/moeru-ai/airi/issues/1761
  it('reports no model listing support instead of throwing when no provider is selected (Issue #1761)', () => {
    const store = useConsciousnessStore()

    expect(store.activeProvider).toBe('')
    expect(() => store.supportsModelListing).not.toThrow()
    expect(store.supportsModelListing).toBe(false)
  })

  it('reports no model listing support for a stale provider id that no longer exists (Issue #1761)', () => {
    const store = useConsciousnessStore()

    store.activeProvider = 'provider-deleted-long-ago'

    expect(() => store.supportsModelListing).not.toThrow()
    expect(store.supportsModelListing).toBe(false)
  })

  it('findProviderMetadata returns metadata for known providers', () => {
    const providersStore = useProvidersStore()

    const metadata = providersStore.findProviderMetadata('openai')

    expect(metadata).toBeDefined()
    expect(metadata?.id).toBe('openai')
  })

  it('findProviderMetadata returns undefined for empty and unknown ids', () => {
    const providersStore = useProvidersStore()

    expect(providersStore.findProviderMetadata('')).toBeUndefined()
    expect(providersStore.findProviderMetadata('nope')).toBeUndefined()
  })

  // ROOT CAUSE:
  //
  // The model selection was only cleared on provider switches by a watcher in
  // the consciousness settings page. Provider changes made anywhere else
  // (onboarding, character cards, provider deletion) kept the previous
  // provider's model id, and the next chat request failed upstream with
  // 404 model_not_found (e.g. "Model gpt-oss-120b does not exist").
  //
  // We fixed this by moving the reset into the store itself, next to the
  // state it protects.
  //
  // https://github.com/moeru-ai/airi/issues/1761
  it('clears the model selection when the provider changes (Issue #1761)', () => {
    const store = useConsciousnessStore()

    store.activeProvider = 'cerebras'
    store.activeModel = 'gpt-oss-120b'
    store.customModelName = 'custom-name'

    store.activeProvider = 'openai'

    expect(store.activeModel).toBe('')
    expect(store.customModelName).toBe('')
  })

  it('clears the model synchronously so callers can set a new one right after', () => {
    const store = useConsciousnessStore()

    store.activeProvider = 'cerebras'
    store.activeModel = 'gpt-oss-120b'

    // The set-provider-then-set-model sequence used by auth provider sync and
    // character cards must keep the newly assigned model.
    store.activeProvider = 'official-provider'
    store.activeModel = 'auto'

    expect(store.activeModel).toBe('auto')
  })

  it('keeps the persisted model when the provider stays the same', () => {
    const store = useConsciousnessStore()

    store.activeProvider = 'openai'
    store.activeModel = 'gpt-4o-mini'

    store.activeProvider = 'openai'

    expect(store.activeModel).toBe('gpt-4o-mini')
  })
})

describe('resolveActiveConsciousnessProviderError', () => {
  // ROOT CAUSE:
  //
  // The chat send paths passed the raw Consciousness selection straight into
  // providersStore.getProviderInstance(). With no provider selected yet
  // (settings/consciousness/active-provider defaults to ''), that lookup
  // throws the internal "Provider metadata for  not found" error, and the
  // send paths pushed that raw error onto the chat screen. An empty model is
  // the same "module not configured" class: the request is doomed upstream.
  //
  // We fixed this by resolving a user-facing setup hint from the active
  // provider and model before provider instantiation.
  //
  // https://github.com/moeru-ai/airi/issues/1761
  it('returns a setup hint when no chat provider is selected', () => {
    expect(resolveActiveConsciousnessProviderError('', '')).toBe('No active chat provider selected. Select a provider in Settings > Consciousness.')
  })

  it('reports the provider first even when a model is already set', () => {
    expect(resolveActiveConsciousnessProviderError('', 'gpt-4o-mini')).toBe('No active chat provider selected. Select a provider in Settings > Consciousness.')
  })

  it('returns a setup hint when a provider is selected but no model is', () => {
    expect(resolveActiveConsciousnessProviderError('openai', '')).toBe('No active chat model selected. Select a model in Settings > Consciousness.')
  })

  it('treats a whitespace-only model as missing', () => {
    expect(resolveActiveConsciousnessProviderError('openai', '   ')).toBe('No active chat model selected. Select a model in Settings > Consciousness.')
  })

  it('allows a fully configured selection', () => {
    expect(resolveActiveConsciousnessProviderError('openai', 'gpt-4o-mini')).toBeUndefined()
  })
})

describe('providers store empty-id diagnostics', () => {
  // ROOT CAUSE:
  //
  // getProviderMetadata/getProviderInstance interpolated the requested id
  // into "Provider metadata for <id> not found", so an unset selection
  // produced the empty-hole text "Provider metadata for  not found" — a
  // message that hides the real problem (nothing selected) and cannot be
  // acted on.
  //
  // We fixed this by throwing an actionable diagnostic for the empty id
  // instead, while keeping the original text for unknown non-empty ids.
  //
  // https://github.com/moeru-ai/airi/issues/1761
  it('throws an actionable error instead of the empty-hole lookup text for an empty provider id', () => {
    const providersStore = useProvidersStore()

    expect(() => providersStore.getProviderMetadata('')).toThrow('Provider metadata requested without a provider id')
  })

  it('rejects empty provider ids from getProviderInstance with an actionable error', async () => {
    const providersStore = useProvidersStore()

    await expect(providersStore.getProviderInstance('')).rejects.toThrow('Provider instance requested without a provider id')
  })
})
