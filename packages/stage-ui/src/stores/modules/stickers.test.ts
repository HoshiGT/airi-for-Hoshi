import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { useLlmToolsetPromptsStore } from '../llm-toolset-prompts'
import { useStickersStore } from './stickers'

// In-memory localforage stand-in: the real one needs IndexedDB, which the node
// test env does not provide. Only the instance methods the store uses exist.
const imageStore = new Map<string, Blob>()
vi.mock('localforage', () => ({
  default: {
    createInstance: () => ({
      setItem: async (key: string, value: Blob) => {
        imageStore.set(key, value)
        return value
      },
      getItem: async (key: string) => imageStore.get(key) ?? null,
      removeItem: async (key: string) => {
        imageStore.delete(key)
      },
      clear: async () => {
        imageStore.clear()
      },
    }),
  },
}))

const runVisionInferenceMock = vi.fn<(input: { imageDataUrl: string, promptOverride?: string }) => Promise<string>>()
vi.mock('../../composables/vision/use-vision-inference', () => ({
  useVisionInference: () => ({ runVisionInference: runVisionInferenceMock }),
}))

const visionStoreState = { activeProvider: '', activeModel: '' }
vi.mock('./vision', () => ({
  useVisionStore: () => visionStoreState,
}))

function makeStickerFile(name = 'happy-cat.png'): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' })
}

describe('stickers store', () => {
  beforeEach(() => {
    // No localStorage in the node env: useLocalStorageManualReset falls back to
    // plain refs, so a fresh pinia per test is enough isolation.
    setActivePinia(createPinia())
    imageStore.clear()
    runVisionInferenceMock.mockReset()
    visionStoreState.activeProvider = ''
    visionStoreState.activeModel = ''
  })

  it('registers the toolset prompt only when enabled with at least one sticker', async () => {
    const stickersStore = useStickersStore()
    const promptsStore = useLlmToolsetPromptsStore()

    expect(promptsStore.activeToolsetPrompt).toBe('')

    stickersStore.enabled = true
    await nextTick()
    expect(promptsStore.activeToolsetPrompt).toBe('')

    await stickersStore.addSticker(makeStickerFile())
    await nextTick()
    expect(promptsStore.activeToolsetPrompt).toContain('<|STICKER_')
    expect(promptsStore.activeToolsetPrompt).toContain('happy-cat')

    stickersStore.enabled = false
    await nextTick()
    expect(promptsStore.activeToolsetPrompt).toBe('')
  })

  it('falls back to the filename stem when no vision model is configured', async () => {
    const stickersStore = useStickersStore()
    const meta = await stickersStore.addSticker(makeStickerFile('挠头猫猫.png'))

    expect(runVisionInferenceMock).not.toHaveBeenCalled()
    expect(meta.name).toBe('挠头猫猫')
    expect(meta.description).toBe('')
  })

  it('uses the vision suggestion (with code fences tolerated) when available', async () => {
    visionStoreState.activeProvider = 'vision-ollama'
    visionStoreState.activeModel = 'qwen2.5vl'
    runVisionInferenceMock.mockResolvedValueOnce('```json\n{"name": "狂喜", "description": "非常兴奋开心的时候用"}\n```')

    const stickersStore = useStickersStore()
    const meta = await stickersStore.addSticker(makeStickerFile())

    expect(runVisionInferenceMock).toHaveBeenCalledTimes(1)
    expect(meta.name).toBe('狂喜')
    expect(meta.description).toBe('非常兴奋开心的时候用')
  })

  it('keeps the sticker with a filename fallback when vision tagging throws', async () => {
    visionStoreState.activeProvider = 'vision-ollama'
    visionStoreState.activeModel = 'qwen2.5vl'
    runVisionInferenceMock.mockRejectedValueOnce(new Error('model offline'))

    const stickersStore = useStickersStore()
    const meta = await stickersStore.addSticker(makeStickerFile('shrug.png'))

    expect(meta.name).toBe('shrug')
    expect(stickersStore.stickers).toHaveLength(1)
  })

  it('deduplicates names with numeric suffixes', async () => {
    const stickersStore = useStickersStore()
    const first = await stickersStore.addSticker(makeStickerFile('cat.png'))
    const second = await stickersStore.addSticker(makeStickerFile('cat.png'))

    expect(first.name).toBe('cat')
    expect(second.name).toBe('cat-2')
  })

  it('sanitizes marker-breaking characters out of names', async () => {
    const stickersStore = useStickersStore()
    const meta = await stickersStore.addSticker(makeStickerFile('a|>b<c.png'))

    expect(meta.name).toBe('abc')
  })

  it('resolves data URLs by marker name and rejects unknown names', async () => {
    const stickersStore = useStickersStore()
    const meta = await stickersStore.addSticker(makeStickerFile())

    const dataUrl = await stickersStore.getDataUrlByName(meta.name)
    expect(dataUrl).toMatch(/^data:image\/png;base64,/)

    expect(await stickersStore.getDataUrlByName('不存在的名字')).toBeUndefined()
  })

  it('removes blob and metadata together', async () => {
    const stickersStore = useStickersStore()
    const meta = await stickersStore.addSticker(makeStickerFile())

    await stickersStore.removeSticker(meta.id)

    expect(stickersStore.stickers).toHaveLength(0)
    expect(imageStore.size).toBe(0)
    expect(await stickersStore.getDataUrlByName(meta.name)).toBeUndefined()
  })

  describe('data export', () => {
    /** Drops every trace of the current install, the way a second device starts out. */
    function switchToEmptyInstall() {
      setActivePinia(createPinia())
      imageStore.clear()
      return useStickersStore()
    }

    async function bytesOf(blob: Blob | undefined): Promise<number[]> {
      if (!blob)
        return []
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    }

    it('round-trips the library onto another install', async () => {
      const source = useStickersStore()
      source.enabled = true
      const first = await source.addSticker(makeStickerFile('狂喜.png'))
      const second = await source.addSticker(makeStickerFile('摆烂.png'))

      const bundle = await source.exportStickers()
      expect(bundle.enabled).toBe(true)
      expect(bundle.items).toHaveLength(2)
      expect(bundle.items[0].image).toMatch(/^data:image\/png;base64,/)

      const target = switchToEmptyInstall()
      await target.importStickers(bundle)

      expect(target.stickers.map(sticker => sticker.name)).toEqual(['狂喜', '摆烂'])
      expect(target.enabled).toBe(true)
      expect(await bytesOf(imageStore.get(first.id))).toEqual([1, 2, 3, 4])
      expect(await bytesOf(imageStore.get(second.id))).toEqual([1, 2, 3, 4])
      expect(await target.getDataUrlByName('狂喜')).toMatch(/^data:image\/png;base64,/)
    })

    it('keeps the image out of the stored metadata', async () => {
      const source = useStickersStore()
      await source.addSticker(makeStickerFile())
      const bundle = await source.exportStickers()

      const target = switchToEmptyInstall()
      await target.importStickers(bundle)

      // The metadata list is mirrored into localStorage; a handful of inlined
      // data URLs there would blow the quota.
      expect(target.stickers[0]).not.toHaveProperty('image')
    })

    it('skips stickers already present so re-importing never duplicates', async () => {
      const source = useStickersStore()
      await source.addSticker(makeStickerFile('cat.png'))
      const bundle = await source.exportStickers()

      const target = switchToEmptyInstall()
      await target.importStickers(bundle)
      await target.importStickers(bundle)

      expect(target.stickers).toHaveLength(1)
      expect(target.stickers[0].name).toBe('cat')
    })

    it('renames an incoming sticker whose name is already taken', async () => {
      const source = useStickersStore()
      const incoming = await source.addSticker(makeStickerFile('cat.png'))
      const bundle = await source.exportStickers()

      const target = switchToEmptyInstall()
      const existing = await target.addSticker(makeStickerFile('cat.png'))
      await target.importStickers(bundle)

      expect(target.stickers.map(sticker => sticker.name)).toEqual(['cat', 'cat-2'])
      // Both blobs survive: the rename resolves the marker clash without
      // dropping either image.
      expect(imageStore.has(existing.id)).toBe(true)
      expect(imageStore.has(incoming.id)).toBe(true)
    })

    it('drops a sticker whose image has gone missing instead of exporting a dead name', async () => {
      const source = useStickersStore()
      const kept = await source.addSticker(makeStickerFile('kept.png'))
      const orphaned = await source.addSticker(makeStickerFile('orphaned.png'))
      imageStore.delete(orphaned.id)

      const bundle = await source.exportStickers()

      expect(bundle.items.map(item => item.id)).toEqual([kept.id])
    })

    it('skips an unreadable image instead of aborting the whole import', async () => {
      const source = useStickersStore()
      await source.addSticker(makeStickerFile('good.png'))
      const bundle = await source.exportStickers()
      bundle.items.unshift({
        id: 'broken-sticker',
        name: 'broken',
        description: '',
        addedAt: Date.now(),
        image: 'not-a-data-url',
      })

      const target = switchToEmptyInstall()
      await target.importStickers(bundle)

      expect(target.stickers.map(sticker => sticker.name)).toEqual(['good'])
    })

    it('never switches the feature off for the importing install', async () => {
      const source = useStickersStore()
      source.enabled = false
      await source.addSticker(makeStickerFile())
      const bundle = await source.exportStickers()

      const target = switchToEmptyInstall()
      target.enabled = true
      await target.importStickers(bundle)

      expect(target.enabled).toBe(true)
    })
  })
})
