import localforage from 'localforage'

import { formatStickerMarker } from '@proj-airi/core-agent'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, watch } from 'vue'

import { useVisionInference } from '../../composables/vision/use-vision-inference'
import { useLlmToolsetPromptsStore } from '../llm-toolset-prompts'
import { useVisionStore } from './vision'

/**
 * One sticker in the library. The image blob itself lives in IndexedDB
 * (localforage, keyed by {@link StickerMeta.id}); only this metadata is kept in
 * localStorage so the settings snapshot stays tiny.
 */
export interface StickerMeta {
  id: string
  /** Unique display name; this is what the model writes inside the marker. */
  name: string
  /** What the sticker conveys — shown to the model so it can pick well. */
  description: string
  addedAt: number
}

/** Result of vision auto-tagging a freshly uploaded sticker image. */
export interface StickerTagSuggestion {
  name: string
  description: string
}

// Separate localforage instance so sticker blobs never collide with
// display-model files, which use the default instance with bare ids as keys.
const stickerImages = localforage.createInstance({ name: 'airi-stickers' })

/**
 * Marker names are embedded verbatim inside `<|STICKER_...|>`; a `|` or `>`
 * could terminate the marker early, and newlines would break the prompt list.
 */
function sanitizeStickerName(raw: string): string {
  return raw.replace(/[|<>\n\r]/g, '').trim().slice(0, 24)
}

const AUTO_TAG_PROMPT = [
  '这是一张聊天表情包。请用 JSON 格式回答,不要输出任何其他内容:',
  '{"name": "2-8个字的短名字", "description": "一句话描述它表达的情绪和适用场景"}',
  '名字要口语化、有辨识度(比如"疑惑猫猫"、"摆烂"、"狂喜"),不要用"图片"、"表情"这类泛称。',
].join('\n')

/**
 * Parses the auto-tag model reply. Models often wrap JSON in code fences or
 * prepend chatter, so this scans for the first `{...}` block instead of
 * trusting the whole reply to be JSON.
 */
function parseTagReply(reply: string): StickerTagSuggestion | undefined {
  const jsonMatch = reply.match(/\{[\s\S]*?\}/)
  if (!jsonMatch)
    return undefined

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { name?: unknown, description?: unknown }
    const name = sanitizeStickerName(typeof parsed.name === 'string' ? parsed.name : '')
    const description = typeof parsed.description === 'string' ? parsed.description.trim() : ''
    if (!name)
      return undefined
    return { name, description }
  }
  catch {
    return undefined
  }
}

// arrayBuffer + btoa instead of FileReader so this also runs in node-env
// tests; chunked fromCharCode keeps big stickers off the call-stack limit.
async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
}

function buildStickerToolsetPrompt(stickers: StickerMeta[]): string {
  const lines = [
    'You have a sticker (表情包) library. You can send a sticker inline by writing a marker in your reply, e.g.:',
    `${formatStickerMarker(stickers[0]?.name ?? '名字')}`,
    '',
    'Available stickers (marker name: meaning):',
    ...stickers.map(sticker => `- ${sticker.name}: ${sticker.description || '(no description)'}`),
    '',
    'Rules:',
    '- MOST replies should NOT include a sticker. Only send one when the emotion is strong or the moment truly calls for it.',
    '- Send at most ONE sticker per reply.',
    '- The name inside the marker must match one of the listed names EXACTLY. Never invent sticker names.',
    '- Place the marker where the sticker should appear, usually at the end of the sentence it reacts to.',
    '- Think of stickers like seasoning: a little goes a long way. Sending one every reply makes them meaningless.',
  ]
  return lines.join('\n')
}

/**
 * The sticker (表情包) library: user-uploaded images the model can send inline
 * via `<|STICKER_名字|>` markers.
 *
 * Owns three pieces of state with different lifetimes:
 * - metadata list + enabled flag: localStorage (survives export/import of settings)
 * - image blobs: IndexedDB via localforage instance `airi-stickers`
 * - object URLs: in-memory render cache, revoked on removal
 *
 * Registers the paired toolset prompt (sticker list + marker rules) iff the
 * feature is enabled and at least one sticker exists, mirroring the web-search
 * pattern: the model is never told about stickers it cannot send.
 */
export const useStickersStore = defineStore('stickers', () => {
  const toolsetPromptsStore = useLlmToolsetPromptsStore()
  const visionStore = useVisionStore()
  const { runVisionInference } = useVisionInference()

  const enabled = useLocalStorageManualReset<boolean>('settings/stickers/enabled', false)
  const stickers = useLocalStorageManualReset<StickerMeta[]>('settings/stickers/library', [])

  const configured = computed(() => enabled.value && stickers.value.length > 0)
  const visionTaggingAvailable = computed(() => !!visionStore.activeProvider && !!visionStore.activeModel)

  /** Render cache; entries are revoked in removeSticker / resetState. */
  const objectUrls = new Map<string, string>()

  watch([configured, stickers], ([isConfigured]) => {
    if (isConfigured)
      toolsetPromptsStore.registerToolsetPrompts('stickers', [{ id: 'stickers', content: buildStickerToolsetPrompt(stickers.value) }])
    else
      toolsetPromptsStore.clearToolsetPrompts('stickers')
  }, { immediate: true, deep: true })

  function findByName(name: string): StickerMeta | undefined {
    return stickers.value.find(sticker => sticker.name === name)
  }

  /** Appends `-2`, `-3`, ... until the name is unique in the library. */
  function ensureUniqueName(base: string, ignoreId?: string): string {
    const taken = new Set(stickers.value.filter(s => s.id !== ignoreId).map(s => s.name))
    if (!taken.has(base))
      return base
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`
      if (!taken.has(candidate))
        return candidate
    }
  }

  /**
   * Runs vision auto-tagging for an uploaded image. Returns `undefined` when
   * no vision model is configured or the model reply is unusable — callers
   * fall back to a filename-derived name so upload never hard-fails on tagging.
   */
  async function suggestTag(imageDataUrl: string): Promise<StickerTagSuggestion | undefined> {
    if (!visionTaggingAvailable.value)
      return undefined

    try {
      // Workload id is only used as a label when promptOverride is set; there
      // is no sticker-specific workload, so reuse the generic interpret one.
      const reply = await runVisionInference({
        imageDataUrl,
        workloadId: 'screen:interpret',
        promptOverride: AUTO_TAG_PROMPT,
      })
      return parseTagReply(reply)
    }
    catch (error) {
      console.warn('Sticker auto-tagging failed, falling back to filename:', error)
      return undefined
    }
  }

  /**
   * Adds an image to the library. Auto-tags via the vision model when one is
   * configured; otherwise (or on tagging failure) the filename stem becomes
   * the name and the description is left for the user to fill in.
   */
  async function addSticker(file: File): Promise<StickerMeta> {
    const id = crypto.randomUUID()
    await stickerImages.setItem(id, file)

    let tag: StickerTagSuggestion | undefined
    try {
      tag = await suggestTag(await blobToDataUrl(file))
    }
    catch {
      // blob read failure only loses the suggestion, never the sticker
    }

    const filenameStem = sanitizeStickerName(file.name.replace(/\.[^.]+$/, '')) || '表情'
    const meta: StickerMeta = {
      id,
      name: ensureUniqueName(tag?.name ?? filenameStem),
      description: tag?.description ?? '',
      addedAt: Date.now(),
    }
    stickers.value = [...stickers.value, meta]
    return meta
  }

  function updateSticker(id: string, patch: Partial<Pick<StickerMeta, 'name' | 'description'>>): void {
    stickers.value = stickers.value.map((sticker) => {
      if (sticker.id !== id)
        return sticker

      const name = patch.name !== undefined
        ? ensureUniqueName(sanitizeStickerName(patch.name) || sticker.name, id)
        : sticker.name
      return {
        ...sticker,
        name,
        description: patch.description !== undefined ? patch.description.trim() : sticker.description,
      }
    })
  }

  async function removeSticker(id: string): Promise<void> {
    stickers.value = stickers.value.filter(sticker => sticker.id !== id)
    await stickerImages.removeItem(id)
    const url = objectUrls.get(id)
    if (url) {
      URL.revokeObjectURL(url)
      objectUrls.delete(id)
    }
  }

  /** Object URL for rendering in `<img>`; cached until the sticker is removed. */
  async function getObjectUrl(id: string): Promise<string | undefined> {
    const cached = objectUrls.get(id)
    if (cached)
      return cached

    const blob = await stickerImages.getItem<Blob>(id)
    if (!blob)
      return undefined

    const url = URL.createObjectURL(blob)
    objectUrls.set(id, url)
    return url
  }

  /**
   * Data URL by marker name — the delivery format for messaging bridges
   * (OneBot/NapCat accepts `base64://`). Returns `undefined` for names the
   * model invented or stickers whose blob has been deleted.
   */
  async function getDataUrlByName(name: string): Promise<string | undefined> {
    const meta = findByName(name)
    if (!meta)
      return undefined

    const blob = await stickerImages.getItem<Blob>(meta.id)
    if (!blob)
      return undefined

    return blobToDataUrl(blob)
  }

  async function resetState(): Promise<void> {
    for (const url of objectUrls.values())
      URL.revokeObjectURL(url)
    objectUrls.clear()
    await stickerImages.clear()
    enabled.reset()
    stickers.reset()
  }

  return {
    enabled,
    stickers,
    configured,
    visionTaggingAvailable,
    addSticker,
    updateSticker,
    removeSticker,
    findByName,
    getObjectUrl,
    getDataUrlByName,
    resetState,
  }
})
