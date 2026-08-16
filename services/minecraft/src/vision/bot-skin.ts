import type { Bot } from 'mineflayer'

import { Buffer } from 'node:buffer'

/**
 * Mojang's profile endpoint. It is used instead of the (rate-limited, changing) public API because
 * the only thing needed here is the account's own texture metadata.
 */
const SESSION_PROFILE_URL = 'https://sessionserver.mojang.com/session/minecraft/profile'

interface SessionProfile {
  properties?: Array<{ name: string, value: string }>
}

interface TexturePayload {
  textures?: {
    SKIN?: { url?: string }
  }
}

/**
 * Resolves the bot's own Minecraft skin into a `data:image/png;base64,...` data URL for the
 * renderer page.
 *
 * Returns null when the account has no skin published (offline-mode accounts, default skins), so
 * the page keeps the bundled Steve texture instead of treating it as an error. Throws only when
 * the profile exists but the skin cannot actually be downloaded.
 */
export async function fetchBotSkinDataUrl(bot: Bot): Promise<string | null> {
  // Offline-mode clients still carry a uuid, but sessionserver answers 204 for it; the null path
  // below covers that, while a missing `_client` means "not logged in at all".
  const uuid = bot._client?.uuid
  if (!uuid)
    return null

  const profile = await fetchJson<SessionProfile | null>(`${SESSION_PROFILE_URL}/${uuid}`)
  const texturesValue = profile?.properties?.find(property => property.name === 'textures')?.value
  if (!texturesValue)
    return null

  // The value is base64-encoded JSON whose payload points at textures.minecraft.net.
  const payload = JSON.parse(Buffer.from(texturesValue, 'base64').toString('utf8')) as TexturePayload
  const skinUrl = payload.textures?.SKIN?.url
  if (!skinUrl)
    return null

  const response = await fetch(skinUrl)
  if (!response.ok)
    throw new Error(`Skin download from textures.minecraft.net failed with ${response.status}`)

  const png = Buffer.from(await response.arrayBuffer())
  return `data:image/png;base64,${png.toString('base64')}`
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url)

  // Sessionserver answers unknown uuids with 204 No Content rather than an error status.
  if (response.status === 204 || response.status === 404)
    return null

  if (!response.ok)
    throw new Error(`Mojang sessionserver answered ${response.status}`)

  return await response.json() as T
}
