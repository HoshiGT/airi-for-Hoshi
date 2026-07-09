import type { Model } from '@xsai/model'

import { listModels } from '@xsai/model'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listAudioModels } from './openai-compatible-audio-models'

vi.mock('@xsai/model', () => ({
  listModels: vi.fn(),
}))

const listModelsMock = vi.mocked(listModels)

function serverModels(ids: string[]): Model[] {
  return ids.map(id => ({ id, created: 0, object: 'model' as const, owned_by: 'test' }))
}

beforeEach(() => {
  listModelsMock.mockReset()
})

describe('listAudioModels (speech)', () => {
  it('filters a mixed listing down to TTS-looking models', async () => {
    listModelsMock.mockResolvedValue(serverModels(['gpt-4o', 'tts-1', 'kokoro', 'text-embedding-3-small']))

    const models = await listAudioModels({ apiKey: 'k', baseUrl: 'https://api.example.com/v1/' }, 'speech', 'openai-compatible-audio-speech')

    expect(models.map(m => m.id)).toEqual(['tts-1', 'kokoro'])
    expect(models[0].provider).toBe('openai-compatible-audio-speech')
    expect(models[0].name).toBe('tts-1')
  })

  it('falls back to the full listing when no id matches a TTS keyword', async () => {
    // Dedicated local TTS servers often expose ids without any recognizable
    // keyword; hiding everything would look like the server has no models.
    listModelsMock.mockResolvedValue(serverModels(['mimic3-en-us', 'melgan-vocoder']))

    const models = await listAudioModels({ apiKey: 'k', baseUrl: 'https://api.example.com/v1/' }, 'speech', 'openai-compatible-audio-speech')

    expect(models.map(m => m.id)).toEqual(['mimic3-en-us', 'melgan-vocoder'])
  })

  it('returns an empty list without a base URL and performs no request', async () => {
    const models = await listAudioModels({ apiKey: 'k' }, 'speech', 'openai-compatible-audio-speech')

    expect(models).toEqual([])
    expect(listModelsMock).not.toHaveBeenCalled()
  })

  it('lists models without an API key for unauthenticated local servers', async () => {
    listModelsMock.mockResolvedValue(serverModels(['kokoro']))

    const models = await listAudioModels({ baseUrl: 'http://192.168.1.5:8880/v1/' }, 'speech', 'openai-compatible-audio-speech')

    expect(listModelsMock).toHaveBeenCalledWith({ apiKey: undefined, baseURL: 'http://192.168.1.5:8880/v1/' })
    expect(models.map(m => m.id)).toEqual(['kokoro'])
  })

  it('normalizes a base URL without a trailing slash', async () => {
    listModelsMock.mockResolvedValue(serverModels(['tts-1']))

    await listAudioModels({ apiKey: 'k', baseUrl: 'http://192.168.1.5:8880/v1' }, 'speech', 'openai-compatible-audio-speech')

    expect(listModelsMock).toHaveBeenCalledWith({ apiKey: 'k', baseURL: 'http://192.168.1.5:8880/v1/' })
  })

  it('returns an empty list when the /v1/models request fails', async () => {
    // Single-purpose speech servers may not implement /v1/models at all; the
    // settings pages fall back to manual model entry on an empty listing.
    listModelsMock.mockRejectedValue(new Error('404 Not Found'))

    const models = await listAudioModels({ apiKey: 'k', baseUrl: 'https://api.example.com/v1/' }, 'speech', 'openai-compatible-audio-speech')

    expect(models).toEqual([])
  })
})

describe('listAudioModels (transcription)', () => {
  // Transcription discovery used to be hardcoded to an empty list because the
  // official OpenAI /v1/models mixes chat models in. Local ASR servers do list
  // their models there, so discovery now filters instead of refusing.
  it('filters a mixed listing down to ASR-looking models', async () => {
    listModelsMock.mockResolvedValue(serverModels(['whisper-large-v3', 'qwen2.5-7b-instruct', 'funasr-paraformer-zh']))

    const models = await listAudioModels({ apiKey: 'k', baseUrl: 'http://192.168.1.5:8000/v1/' }, 'transcription', 'openai-compatible-audio-transcription')

    expect(models.map(m => m.id)).toEqual(['whisper-large-v3', 'funasr-paraformer-zh'])
    expect(models[0].provider).toBe('openai-compatible-audio-transcription')
  })

  it('keeps only transcription models from an official-OpenAI-shaped listing', async () => {
    listModelsMock.mockResolvedValue(serverModels(['gpt-4o', 'whisper-1', 'gpt-4o-mini-transcribe', 'text-embedding-3-small']))

    const models = await listAudioModels({ apiKey: 'k', baseUrl: 'https://api.openai.com/v1/' }, 'transcription', 'openai-compatible-audio-transcription')

    expect(models.map(m => m.id)).toEqual(['whisper-1', 'gpt-4o-mini-transcribe'])
  })

  it('falls back to the full listing when no id matches an ASR keyword', async () => {
    listModelsMock.mockResolvedValue(serverModels(['wav2vec2-base', 'conformer-zh']))

    const models = await listAudioModels({ apiKey: 'k', baseUrl: 'http://192.168.1.5:8000/v1/' }, 'transcription', 'openai-compatible-audio-transcription')

    expect(models.map(m => m.id)).toEqual(['wav2vec2-base', 'conformer-zh'])
  })

  it('returns an empty list when the /v1/models request fails', async () => {
    listModelsMock.mockRejectedValue(new Error('connection refused'))

    const models = await listAudioModels({ apiKey: 'k', baseUrl: 'http://192.168.1.5:8000/v1/' }, 'transcription', 'openai-compatible-audio-transcription')

    expect(models).toEqual([])
  })
})
