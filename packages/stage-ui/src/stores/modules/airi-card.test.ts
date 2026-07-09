import type { Card } from '@proj-airi/ccc'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OFFICIAL_SPEECH_PROVIDER_ID } from '../../libs/providers/providers/official'
import { useSettingsStageModel } from '../settings/stage-model'
import { useAiriCardStore } from './airi-card'

vi.mock('./artistry', async () => {
  const { defineStore } = await import('pinia')

  return {
    useArtistryStore: defineStore('artistry', {
      state: () => ({
        globalProvider: 'mock-artistry-provider',
        globalModel: 'mock-artistry-model',
        globalPromptPrefix: 'mock-artistry-prefix',
        globalProviderOptions: {},
        activeProvider: 'mock-artistry-provider',
        activeModel: 'mock-artistry-model',
        defaultPromptPrefix: 'mock-artistry-prefix',
        providerOptions: {},
      }),
      actions: {
        resetToGlobal() {},
      },
    }),
  }
})

vi.mock('./consciousness', async () => {
  const { defineStore } = await import('pinia')

  return {
    useConsciousnessStore: defineStore('consciousness', {
      state: () => ({
        activeProvider: 'mock-consciousness-provider',
        activeModel: 'mock-consciousness-model',
      }),
    }),
  }
})

vi.mock('./speech', async () => {
  const { defineStore } = await import('pinia')

  return {
    useSpeechStore: defineStore('speech', {
      state: () => ({
        activeSpeechProvider: 'mock-speech-provider',
        activeSpeechModel: 'mock-speech-model',
        activeSpeechVoiceId: 'mock-speech-voice',
      }),
    }),
  }
})

vi.mock('./vision', async () => {
  const { defineStore } = await import('pinia')

  return {
    useVisionStore: defineStore('vision', {
      state: () => ({
        activeProvider: 'mock-vision-provider',
        activeModel: 'mock-vision-model',
      }),
    }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

/**
 * @example
 * describe('airi-card store', () => {})
 */
describe('airi-card store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /**
   * @example
   * it('persists selected module config on active card', () => {})
   */
  it('persists selected module config on active card', () => {
    const stageModelStore = useSettingsStageModel()
    stageModelStore.stageModelSelected = 'preset-live2d-1'

    const cardStore = useAiriCardStore()
    cardStore.initialize()

    expect(cardStore.updateActiveCardDisplayModel('display-model-iru-v2')).toBe(true)
    expect(cardStore.updateActiveCardConsciousness({ provider: 'openrouter-ai', model: 'anthropic/claude-sonnet' })).toBe(true)
    expect(cardStore.updateActiveCardVision({ provider: 'ollama', model: 'llava' })).toBe(true)
    expect(cardStore.updateActiveCardSpeech({ provider: 'elevenlabs', model: 'eleven_multilingual_v2', voice_id: 'aria' })).toBe(true)
    expect(cardStore.activeCard?.extensions.airi.modules).toMatchObject({
      displayModelId: 'display-model-iru-v2',
      consciousness: { provider: 'openrouter-ai', model: 'anthropic/claude-sonnet' },
      vision: { provider: 'ollama', model: 'llava' },
      speech: { provider: 'elevenlabs', model: 'eleven_multilingual_v2', voice_id: 'aria' },
    })
    expect(stageModelStore.stageModelSelected).toBe('preset-live2d-1')
  })

  /**
   * @example
   * it('freezes a Voice Pack snapshot on the active card', () => {})
   */
  it('freezes a Voice Pack snapshot on the active card', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()

    const pack = {
      id: 'vp-1',
      name: 'Neuro Sama',
      provider: 'volcengine',
      model: 'seed-tts-2.0',
      voiceId: 'voice-neuro',
      ttsModelId: 'volcengine/neuro-pool',
      params: { pitch: '+20%', volume: '+5%' },
      costMultiplier: 1.5,
    }

    const bound = cardStore.bindVoicePackToActiveCard(pack)

    expect(bound).toBe(true)
    expect(cardStore.activeCard?.extensions.airi.modules.speech).toMatchObject({
      provider: OFFICIAL_SPEECH_PROVIDER_ID,
      model: 'volcengine/neuro-pool',
      voice_id: 'voice-neuro',
      voicePack: {
        packId: 'vp-1',
        name: 'Neuro Sama',
        provider: 'volcengine',
        model: 'seed-tts-2.0',
        voiceId: 'voice-neuro',
        ttsModelId: 'volcengine/neuro-pool',
        params: { pitch: '+20%', volume: '+5%' },
        costMultiplier: 1.5,
      },
    })
  })

  /**
   * @example
   * it('keeps the frozen Voice Pack independent from later library edits', () => {})
   */
  it('keeps the frozen Voice Pack independent from later library edits', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()

    const params = { pitch: '+20%' }
    cardStore.bindVoicePackToActiveCard({
      id: 'vp-1',
      name: 'Frozen',
      provider: 'volcengine',
      model: 'seed-tts-2.0',
      voiceId: 'voice-a',
      ttsModelId: 'volcengine/pool-a',
      params,
      costMultiplier: 1,
    })

    params.pitch = '-10%'

    expect(cardStore.activeCard?.extensions.airi.modules.speech.voicePack?.params).toEqual({ pitch: '+20%' })
    expect(cardStore.activeCard?.extensions.airi.modules.speech.voicePack?.voiceId).toBe('voice-a')
  })

  it('importCards adds missing cards but never overwrites local ones', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()

    const added = cardStore.importCards({
      // Collides with the ever-present default card: local copy must win.
      'default': { name: 'Foreign ReLU', version: '9.9.9' },
      'card-foreign-1': { name: 'Yuki', version: '1.0.0', description: 'from backup' },
    })

    expect(added).toEqual(['card-foreign-1'])
    expect(cardStore.getCard('default')?.name).toBe('ReLU')
    const imported = cardStore.getCard('card-foreign-1')
    expect(imported?.name).toBe('Yuki')
    expect(imported?.description).toBe('from backup')
    // Backup cards without an airi extension are normalized on the way in so
    // downstream module lookups never hit an undefined extension.
    expect(imported?.extensions?.airi?.modules).toBeDefined()
  })

  it('exportCards round-trips through JSON into a fresh store', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()
    const yukiId = cardStore.addCard({ name: 'Yuki', version: '1.0.0' })

    // The backup file is JSON, so the Map must survive as a plain record.
    const exported = JSON.parse(JSON.stringify(cardStore.exportCards())) as Record<string, Card>
    expect(Object.keys(exported).sort()).toEqual(['default', yukiId].sort())

    setActivePinia(createPinia())
    const freshStore = useAiriCardStore()
    freshStore.initialize()

    const added = freshStore.importCards(exported)
    // 'default' already exists on the fresh install; only the nanoid card lands.
    expect(added).toEqual([yukiId])
    expect(freshStore.getCard(yukiId)?.name).toBe('Yuki')
  })
})
