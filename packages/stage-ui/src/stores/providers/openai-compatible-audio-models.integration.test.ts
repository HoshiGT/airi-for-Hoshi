import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createServer } from 'node:http'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { listAudioModels } from './openai-compatible-audio-models'

// Integration-style coverage against a real HTTP endpoint: the unit tests mock
// @xsai/model entirely, so they cannot catch header/URL construction issues
// (e.g. sending "Authorization: Bearer undefined" to unauthenticated local
// speech servers). The server below mimics a mixed local audio server such as
// speaches, which lists ASR and TTS models side by side in /v1/models.
const serverModelIds = [
  'Systran/faster-whisper-small',
  'speaches-ai/Kokoro-82M-v1.0-ONNX',
]

let baseUrl = ''
let lastRequestHeaders: IncomingHttpHeaders | undefined

const server = createServer((req, res) => {
  lastRequestHeaders = req.headers

  if (req.url !== '/v1/models') {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    object: 'list',
    data: serverModelIds.map(id => ({ id, created: 0, object: 'model', owned_by: 'local' })),
  }))
})

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}/v1/`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

describe('listAudioModels against a local OpenAI-compatible server', () => {
  it('discovers transcription models anonymously without an Authorization header', async () => {
    const models = await listAudioModels({ baseUrl }, 'transcription', 'openai-compatible-audio-transcription')

    expect(models.map(m => m.id)).toEqual(['Systran/faster-whisper-small'])
    expect(lastRequestHeaders?.authorization).toBeUndefined()
  })

  it('discovers speech models from the same mixed listing', async () => {
    const models = await listAudioModels({ baseUrl }, 'speech', 'openai-compatible-audio-speech')

    expect(models.map(m => m.id)).toEqual(['speaches-ai/Kokoro-82M-v1.0-ONNX'])
  })

  it('sends the API key as a bearer token when one is configured', async () => {
    await listAudioModels({ apiKey: 'local-key', baseUrl }, 'transcription', 'openai-compatible-audio-transcription')

    expect(lastRequestHeaders?.authorization).toBe('Bearer local-key')
  })

  it('returns an empty list when the server has no /v1/models route', async () => {
    const models = await listAudioModels({ baseUrl: `${baseUrl}missing/` }, 'speech', 'openai-compatible-audio-speech')

    expect(models).toEqual([])
  })
})
