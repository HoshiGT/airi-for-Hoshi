import type { Bot } from 'mineflayer'

import { Buffer } from 'node:buffer'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchBotSkinDataUrl } from './bot-skin'

const PROFILE_UUID = '11111111-2222-3333-4444-555555555555'
const SKIN_URL = 'http://textures.minecraft.net/texture/abc123'

const PROFILE_URL = `https://sessionserver.mojang.com/session/minecraft/profile/${PROFILE_UUID}`

const SKIN_PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02])

function botWithUuid(uuid?: string): Bot {
  return { _client: uuid === undefined ? undefined : { uuid } } as unknown as Bot
}

/** Minimal stand-in for `fetch`'s Response; the fetcher only reads status/ok and the two body readers. */
function respond(status: number, body?: unknown, bytes?: Buffer) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    // NOTICE: a Node Buffer shares its underlying pool, so `.buffer` alone would leak unrelated
    // memory; slice the exact view instead. Mirrors how undici turns a body into an ArrayBuffer.
    arrayBuffer: async () => (bytes
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : new ArrayBuffer(0)),
  }
}

function texturesValue(skinUrl: string | null): string {
  const payload = skinUrl === null ? {} : { textures: { SKIN: { url: skinUrl } } }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

function profileBody(skinUrl: string | null) {
  return { properties: [{ name: 'textures', value: texturesValue(skinUrl) }] }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchBotSkinDataUrl', () => {
  it('returns the skin as a png data URL when the profile carries textures', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === PROFILE_URL)
        return respond(200, profileBody(SKIN_URL))
      if (input === SKIN_URL)
        return respond(200, undefined, SKIN_PNG)
      throw new Error(`unexpected URL: ${input}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchBotSkinDataUrl(botWithUuid(PROFILE_UUID))

    expect(result).toBe(`data:image/png;base64,${SKIN_PNG.toString('base64')}`)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns null when the profile has no textures property', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { properties: [] })))

    await expect(fetchBotSkinDataUrl(botWithUuid(PROFILE_UUID))).resolves.toBeNull()
  })

  it('returns null when the texture payload has no skin url', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, profileBody(null))))

    await expect(fetchBotSkinDataUrl(botWithUuid(PROFILE_UUID))).resolves.toBeNull()
  })

  it('returns null when sessionserver does not know the uuid (204)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(204)))

    await expect(fetchBotSkinDataUrl(botWithUuid(PROFILE_UUID))).resolves.toBeNull()
  })

  it('returns null before any network call when the client is not logged in yet', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchBotSkinDataUrl(botWithUuid())).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws when sessionserver answers with an error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(500)))

    await expect(fetchBotSkinDataUrl(botWithUuid(PROFILE_UUID))).rejects.toThrow(/500/)
  })

  it('throws when the skin download fails', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === PROFILE_URL)
        return respond(200, profileBody(SKIN_URL))
      return respond(404)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchBotSkinDataUrl(botWithUuid(PROFILE_UUID))).rejects.toThrow(/404/)
  })
})
