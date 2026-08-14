// @vitest-environment jsdom

import type { Ref } from 'vue'

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import ChatArea from './ChatArea.vue'

const NO_PROVIDER_HINT = 'No active chat provider selected. Select a provider in Settings > Consciousness.'
const NO_MODEL_HINT = 'No active chat model selected. Select a model in Settings > Consciousness.'

let consciousnessStore: {
  activeProvider: Ref<string>
  activeModel: Ref<string>
}

let providersStore: {
  getProviderConfig: ReturnType<typeof vi.fn>
  getProviderInstance: ReturnType<typeof vi.fn>
}

let chatSessionStore: {
  activeSessionId: string
  messages: Ref<{ role: string, content: string }[]>
  setSessionMessages: ReturnType<typeof vi.fn>
}

let chatOrchestrator: {
  ingest: ReturnType<typeof vi.fn>
  onAfterMessageComposed: ReturnType<typeof vi.fn>
}

let stickersStore: {
  configured: Ref<boolean>
}

let settingsAudioDevice: {
  askPermission: ReturnType<typeof vi.fn>
  enabled: Ref<boolean>
  stream: Ref<MediaStream | null>
}

// The send path under test reads the resolver from the real consciousness
// module; only the store hook is replaced so activeProvider/activeModel can be
// driven per test.
vi.mock('@proj-airi/stage-ui/stores/modules/consciousness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@proj-airi/stage-ui/stores/modules/consciousness')>()
  return {
    ...actual,
    useConsciousnessStore: vi.fn(() => consciousnessStore),
  }
})

vi.mock('@proj-airi/stage-ui/stores/providers', () => ({
  useProvidersStore: vi.fn(() => providersStore),
}))

vi.mock('@proj-airi/stage-ui/stores/chat', () => ({
  useChatOrchestratorStore: vi.fn(() => chatOrchestrator),
}))

vi.mock('@proj-airi/stage-ui/stores/chat/session-store', () => ({
  useChatSessionStore: vi.fn(() => chatSessionStore),
}))

vi.mock('@proj-airi/stage-ui/stores/modules/stickers', () => ({
  useStickersStore: vi.fn(() => stickersStore),
  formatStickerMarker: (name: string) => `<sticker:${name}>`,
}))

vi.mock('@proj-airi/stage-ui/stores/settings', async () => {
  const { ref } = await import('vue')
  return {
    useSettings: vi.fn(() => ({ themeColorsHueDynamic: ref(false) })),
    useSettingsAudioDevice: vi.fn(() => settingsAudioDevice),
  }
})

vi.mock('@proj-airi/stage-ui/stores/audio', () => ({
  useAudioContext: vi.fn(() => ({
    audioContext: {
      state: 'suspended',
      createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
    },
  })),
}))

vi.mock('@proj-airi/stage-ui/composables', () => ({
  useAudioAnalyzer: vi.fn(() => ({ startAnalyzer: vi.fn(() => null), stopAnalyzer: vi.fn() })),
}))

vi.mock('../../composables/use-transcriptions', async () => {
  const { ref } = await import('vue')
  return {
    useTranscriptions: vi.fn(() => ({
      isListening: ref(false),
      startStreamingTranscription: vi.fn(),
      stopStreamingTranscription: vi.fn(),
      autoSendEnabled: ref(false),
    })),
  }
})

vi.mock('../../composables/useStopSpeakingButton', async () => {
  const { ref } = await import('vue')
  return {
    useStopSpeakingButton: vi.fn(() => ({
      showStopSpeakingButton: ref(false),
      stopSpeakingFromChat: vi.fn(),
    })),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('pinia', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pinia')>()
  return {
    ...actual,
    // The component only reads refs out of the mocked stores; pass them
    // through unchanged (same pattern as use-transcriptions.test.ts).
    storeToRefs: vi.fn((store: unknown) => store),
  }
})

vi.mock('reka-ui', async () => {
  const { defineComponent } = await import('vue')
  const stub = defineComponent({ name: 'RekaStub', template: '<div><slot /></div>' })
  return {
    DropdownMenuContent: stub,
    DropdownMenuItem: stub,
    DropdownMenuPortal: stub,
    DropdownMenuRoot: stub,
    DropdownMenuTrigger: stub,
    PopoverContent: stub,
    PopoverPortal: stub,
    PopoverRoot: stub,
    PopoverTrigger: stub,
  }
})

vi.mock('@proj-airi/stage-ui/components/scenarios/chat', async () => {
  const { defineComponent } = await import('vue')
  return {
    StickerPicker: defineComponent({ name: 'StickerPickerStub', template: '<div />' }),
  }
})

vi.mock('@proj-airi/stage-ui/components/scenarios/dialogs/audio-input/index', async () => {
  const { defineComponent } = await import('vue')
  return {
    HearingConfig: defineComponent({ name: 'HearingConfigStub', template: '<div />' }),
  }
})

vi.mock('./IndicatorMicVolume.vue', async () => {
  const { defineComponent } = await import('vue')
  return {
    default: defineComponent({ name: 'IndicatorMicVolumeStub', template: '<div />' }),
  }
})

vi.mock('@proj-airi/ui', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    BasicTextarea: defineComponent({
      name: 'BasicTextarea',
      props: {
        modelValue: { type: String, default: '' },
      },
      emits: ['update:modelValue'],
      render() {
        return h('textarea', {
          value: this.modelValue,
          onInput: (event: Event) => this.$emit('update:modelValue', (event.target as HTMLTextAreaElement).value),
        })
      },
    }),
  }
})

describe('chatArea send path with no provider selected', () => {
  beforeEach(() => {
    consciousnessStore = {
      activeProvider: ref(''),
      activeModel: ref(''),
    }
    providersStore = {
      getProviderConfig: vi.fn(() => undefined),
      // Mirrors the real store: empty ids were the historical raw-throw case
      // that surfaced as "Provider metadata for  not found" on screen.
      getProviderInstance: vi.fn().mockImplementation(async (providerId: string) => {
        if (!providerId) {
          throw new Error('Provider metadata for  not found')
        }
        return { chat: providerId }
      }),
    }
    chatSessionStore = {
      activeSessionId: 'session-1',
      messages: ref<{ role: string, content: string }[]>([]),
      setSessionMessages: vi.fn(),
    }
    chatOrchestrator = {
      ingest: vi.fn().mockResolvedValue(undefined),
      onAfterMessageComposed: vi.fn(),
    }
    stickersStore = {
      configured: ref(false),
    }
    settingsAudioDevice = {
      askPermission: vi.fn().mockResolvedValue(undefined),
      enabled: ref(false),
      stream: ref<MediaStream | null>(null),
    }
  })

  async function typeAndPressEnter(wrapper: ReturnType<typeof mount>, text: string) {
    await wrapper.find('textarea').setValue(text)
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
  }

  // ROOT CAUSE:
  //
  // Sending with no provider selected passed the empty
  // settings/consciousness/active-provider value straight into
  // providersStore.getProviderInstance(''), which throws the internal lookup
  // error "Provider metadata for  not found". The send paths caught it and
  // pushed that raw error onto the chat screen. An empty model has the same
  // shape: the request is doomed, but the raw failure only surfaces upstream.
  //
  // We fixed this by resolving a user-facing setup hint from the active
  // provider and model before provider instantiation, and by showing that hint
  // instead of the providers store internals.
  //
  // https://github.com/moeru-ai/airi/issues/1761
  it('shows a setup hint instead of a raw provider lookup error when no chat provider is selected (Issue #1761)', async () => {
    const wrapper = mount(ChatArea)

    await typeAndPressEnter(wrapper, 'hello')

    expect(providersStore.getProviderInstance).not.toHaveBeenCalled()
    expect(providersStore.getProviderConfig).not.toHaveBeenCalled()
    expect(chatOrchestrator.ingest).not.toHaveBeenCalled()
    expect(chatSessionStore.setSessionMessages).toHaveBeenCalledWith('session-1', [
      { role: 'error', content: NO_PROVIDER_HINT },
    ])
    // The failed send still restores the draft so the user does not lose it.
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('hello')
  })

  it('shows a setup hint instead of sending with an empty model', async () => {
    consciousnessStore.activeProvider.value = 'openai'
    consciousnessStore.activeModel.value = ''

    const wrapper = mount(ChatArea)

    await typeAndPressEnter(wrapper, 'hello')

    expect(providersStore.getProviderInstance).not.toHaveBeenCalled()
    expect(chatOrchestrator.ingest).not.toHaveBeenCalled()
    expect(chatSessionStore.setSessionMessages).toHaveBeenCalledWith('session-1', [
      { role: 'error', content: NO_MODEL_HINT },
    ])
  })

  it('keeps the normal send path intact when provider and model are selected', async () => {
    consciousnessStore.activeProvider.value = 'openai'
    consciousnessStore.activeModel.value = 'gpt-4o-mini'

    const wrapper = mount(ChatArea)

    await typeAndPressEnter(wrapper, 'hello')

    expect(providersStore.getProviderInstance).toHaveBeenCalledWith('openai')
    expect(chatOrchestrator.ingest).toHaveBeenCalledWith('hello', expect.objectContaining({ model: 'gpt-4o-mini' }))
    expect(chatSessionStore.setSessionMessages).not.toHaveBeenCalled()
  })
})
