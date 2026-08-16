import path from 'node:path'

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

import {
  generateStartupSummary,
  MAX_SUMMARY_CHARS,
  readSummaryProviderConfig,
  SessionMemoryStore,
} from './session-memory'

function tempFile(name = 'session-memory.json'): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'mc-session-')), name)
}

const provider = { baseUrl: 'http://localhost:1234/v1/', apiKey: 'unused', model: 'deepseek-chat' }

describe('sessionMemoryStore', () => {
  it('round-trips the tail of a conversation', () => {
    const filePath = tempFile()
    const store = new SessionMemoryStore({ filePath })

    store.write([
      { role: 'user', content: 'where is home?' },
      { role: 'assistant', content: 'at 100 64 -200' },
    ] as any)

    const read = store.read()
    expect(read?.transcript).toEqual([
      { role: 'user', content: 'where is home?' },
      { role: 'assistant', content: 'at 100 64 -200' },
    ])
  })

  it('keeps only the most recent messages', () => {
    const filePath = tempFile()
    const store = new SessionMemoryStore({ filePath })

    const history = Array.from({ length: 120 }, (_, i) => ({ role: 'user', content: `m${i}` }))
    store.write(history as any)

    const read = store.read()
    expect(read!.transcript.length).toBeLessThanOrEqual(40)
    expect(read!.transcript.at(-1)!.content).toBe('m119')
  })

  it('returns null rather than throwing when the file is absent', () => {
    expect(new SessionMemoryStore({ filePath: tempFile() }).read()).toBeNull()
  })

  it('discards a corrupt file instead of crashing startup', () => {
    const filePath = tempFile()
    writeFileSync(filePath, '{ not json')
    expect(new SessionMemoryStore({ filePath }).read()).toBeNull()

    writeFileSync(filePath, JSON.stringify({ version: 99, nonsense: true }))
    expect(new SessionMemoryStore({ filePath }).read()).toBeNull()
  })

  it('ignores memory older than a week — stale coordinates are worse than none', () => {
    const filePath = tempFile()
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      transcript: [{ role: 'user', content: 'home is here' }],
    }))

    expect(new SessionMemoryStore({ filePath }).read()).toBeNull()
  })

  it('writes nothing when there is no usable transcript', () => {
    const filePath = tempFile()
    const store = new SessionMemoryStore({ filePath })
    store.write([])
    expect(store.read()).toBeNull()
  })

  it('leaves no temp file behind after an atomic write', () => {
    const filePath = tempFile()
    const store = new SessionMemoryStore({ filePath })
    store.write([{ role: 'user', content: 'hello' }] as any)

    expect(() => readFileSync(filePath, 'utf8')).not.toThrow()
    expect(() => readFileSync(`${filePath}.tmp`, 'utf8')).toThrow()
  })
})

describe('readSummaryProviderConfig', () => {
  it('is disabled unless both base URL and model are given', () => {
    expect(readSummaryProviderConfig({} as any)).toBeNull()
    expect(readSummaryProviderConfig({ SUMMARY_API_BASEURL: 'http://x/' } as any)).toBeNull()
    expect(readSummaryProviderConfig({ SUMMARY_MODEL: 'deepseek-chat' } as any)).toBeNull()
  })

  it('defaults the API key, since local gateways often ignore it', () => {
    const config = readSummaryProviderConfig({
      SUMMARY_API_BASEURL: 'http://localhost:1234/v1/',
      SUMMARY_MODEL: 'deepseek-chat',
    } as any)

    expect(config).toEqual({
      baseUrl: 'http://localhost:1234/v1/',
      model: 'deepseek-chat',
      apiKey: 'unused',
    })
  })
})

describe('generateStartupSummary', () => {
  function storeWith(transcript: Array<{ role: string, content: string }>): SessionMemoryStore {
    const filePath = tempFile()
    writeFileSync(filePath, JSON.stringify({ version: 1, savedAt: Date.now(), transcript }))
    return new SessionMemoryStore({ filePath })
  }

  it('returns nothing when no provider is configured, without touching the model', () => {
    const callModel = vi.fn()
    return expect(generateStartupSummary({
      provider: null,
      store: storeWith([{ role: 'user', content: 'hi' }]),
      callModel,
    })).resolves.toBeUndefined().then(() => expect(callModel).not.toHaveBeenCalled())
  })

  it('returns nothing when there is no previous session', async () => {
    const callModel = vi.fn()
    const result = await generateStartupSummary({
      provider,
      store: new SessionMemoryStore({ filePath: tempFile() }),
      callModel,
    })

    expect(result).toBeUndefined()
    expect(callModel).not.toHaveBeenCalled()
  })

  it('passes the transcript to the model and returns its summary', async () => {
    const callModel = vi.fn(async () => '家在 (100, 64, -200),主人是 dssadg。')
    const result = await generateStartupSummary({
      provider,
      store: storeWith([{ role: 'user', content: '家在哪' }]),
      callModel,
    })

    expect(result).toBe('家在 (100, 64, -200),主人是 dssadg。')
    expect(callModel).toHaveBeenCalledWith(provider, 'user: 家在哪')
  })

  it('treats the NONE sentinel as "nothing durable happened"', async () => {
    const result = await generateStartupSummary({
      provider,
      store: storeWith([{ role: 'user', content: 'hi' }]),
      callModel: async () => 'NONE',
    })

    expect(result).toBeUndefined()
  })

  it('clamps an over-long summary, since it is resident in every request', async () => {
    const result = await generateStartupSummary({
      provider,
      store: storeWith([{ role: 'user', content: 'hi' }]),
      callModel: async () => 'x'.repeat(5000),
    })

    expect(result!.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS)
  })

  it('never lets a summariser failure block startup', async () => {
    const result = await generateStartupSummary({
      provider,
      store: storeWith([{ role: 'user', content: 'hi' }]),
      callModel: async () => {
        throw new Error('connection refused')
      },
    })

    expect(result).toBeUndefined()
  })
})
