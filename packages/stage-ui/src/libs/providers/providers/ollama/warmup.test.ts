import { afterEach, describe, expect, it, vi } from 'vitest'

import { warmUpOllamaModel } from './index'

describe('warmUpOllamaModel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts an empty load request to the native /api/generate endpoint at the server origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ done: true, done_reason: 'load' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await warmUpOllamaModel('http://localhost:11434/v1/', 'qwythos-nothink:latest')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    // The native preload endpoint lives at the root, not under the OpenAI-compat /v1/ path.
    expect(url).toBe('http://localhost:11434/api/generate')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ model: 'qwythos-nothink:latest', stream: false })
  })

  it('forwards the abort signal to fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await warmUpOllamaModel('http://localhost:11434/v1/', 'qwythos-nothink:latest', controller.signal)

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal)
  })

  it('derives origin even when the base URL has a non-default host and port', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    vi.stubGlobal('fetch', fetchMock)

    await warmUpOllamaModel('http://192.168.1.50:11500/v1/', 'qwen2.5:3b')

    expect(fetchMock.mock.calls[0][0]).toBe('http://192.168.1.50:11500/api/generate')
  })

  it('throws when the server responds non-ok so the preload scheduler logs a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }))

    await expect(warmUpOllamaModel('http://localhost:11434/v1/', 'missing-model'))
      .rejects
      .toThrow(/Ollama warm-up for "missing-model" failed: 404/)
  })
})
