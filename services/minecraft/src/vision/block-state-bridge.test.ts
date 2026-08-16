import type { IndexedData } from 'minecraft-data'

import minecraftData from 'minecraft-data'
import PrismarineChunk from 'prismarine-chunk'

import { Vec3 } from 'vec3'
import { describe, expect, it } from 'vitest'

import { createBlockStateBridge, pickViewerVersion } from './block-state-bridge'

// The bot speaks whatever the server negotiated; the viewer bundle stops at 1.21.4.
const BOT_VERSION = '1.21.11'
const VIEWER_VERSION = '1.21.4'
const VIEWER_SUPPORTED = ['1.16.4', '1.17.1', '1.18.1', '1.19', '1.20.1', '1.21.1', '1.21.4']

const source: IndexedData = minecraftData(BOT_VERSION)
const target: IndexedData = minecraftData(VIEWER_VERSION)

// The loader's return type is a union of the Java and Bedrock implementations; this project only
// ever speaks Java, so narrowing it once here keeps every call site free of casts.
type JavaChunkColumnConstructor = Extract<
  ReturnType<typeof PrismarineChunk>,
  { prototype: { skyLightSent: boolean } }
>
type JavaChunkColumn = InstanceType<JavaChunkColumnConstructor>

function chunkColumnFor(version: string): JavaChunkColumnConstructor {
  return PrismarineChunk(version) as JavaChunkColumnConstructor
}

const MIN_Y = -64
const WORLD_HEIGHT = 384
const SECTION_HEIGHT = 16

function sectionIndexOf(y: number): number {
  return Math.floor((y - MIN_Y) / SECTION_HEIGHT)
}

function sourceState(name: string): number {
  const block = source.blocksByName[name]
  if (!block)
    throw new Error(`${name} does not exist on ${BOT_VERSION}`)
  return block.defaultState ?? 0
}

function targetState(name: string): number {
  const block = target.blocksByName[name]
  if (!block)
    throw new Error(`${name} does not exist on ${VIEWER_VERSION}`)
  return block.defaultState ?? 0
}

/**
 * Builds a real chunk column with the same library mineflayer uses, so the serialized shape under
 * test is the one that actually arrives at runtime rather than a hand-written approximation.
 */
function buildColumn(fill: (setBlock: (x: number, y: number, z: number, stateId: number) => void) => void) {
  const ChunkColumn = chunkColumnFor(BOT_VERSION)
  const column = new ChunkColumn({ minY: MIN_Y, worldHeight: WORLD_HEIGHT })
  fill((x, y, z, stateId) => column.setBlockStateId(new Vec3(x, y, z), stateId))
  return column
}

/** Block index within a 16³ section, as prismarine-chunk lays them out. */
function sectionBlockIndex(x: number, y: number, z: number): number {
  return ((y & 15) << 8) | (z << 4) | x
}

/**
 * Unpacks a serialized BitArray into plain state ids.
 *
 * Mirrors the layout documented in `block-state-bridge`: values never straddle a 64-bit boundary,
 * but may straddle the two 32-bit words inside one.
 */
function decodePacked(json: string): number[] {
  const { data, capacity, bitsPerValue, valuesPerLong, valueMask } = JSON.parse(json) as {
    data: number[]
    capacity: number
    bitsPerValue: number
    valuesPerLong: number
    valueMask: number
  }

  const words = Uint32Array.from(data)
  const values: number[] = []

  for (let index = 0; index < capacity; index++) {
    const longIndex = Math.floor(index / valuesPerLong)
    const bitOffset = (index - longIndex * valuesPerLong) * bitsPerValue

    if (bitOffset >= 32) {
      values.push((words[longIndex * 2 + 1] >>> (bitOffset - 32)) & valueMask)
      continue
    }

    let value = words[longIndex * 2] >>> bitOffset
    if (bitOffset + bitsPerValue > 32)
      value |= words[longIndex * 2 + 1] << (32 - bitOffset)

    values.push(value & valueMask)
  }

  return values
}

/** Reads one section's storage back out of a serialized column. */
function storageOf(json: string, y: number): Record<string, unknown> {
  const column = JSON.parse(json) as { sections: string[] }
  const section = JSON.parse(column.sections[sectionIndexOf(y)]) as { data: string }
  return JSON.parse(section.data) as Record<string, unknown>
}

describe('pickViewerVersion', () => {
  it('keeps the bot version when the viewer supports it', () => {
    expect(pickViewerVersion('1.21.4', VIEWER_SUPPORTED)).toBe('1.21.4')
    expect(pickViewerVersion('1.20.1', VIEWER_SUPPORTED)).toBe('1.20.1')
  })

  it('falls back to the newest supported version older than the bot', () => {
    expect(pickViewerVersion('1.21.11', VIEWER_SUPPORTED)).toBe('1.21.4')
  })

  it('does not sort versions as strings', () => {
    // "1.21.11" < "1.21.4" lexicographically, which would pick 1.21.1 instead of 1.21.4.
    expect(pickViewerVersion('1.21.11', ['1.21.1', '1.21.4'])).toBe('1.21.4')
  })

  it('uses the oldest supported version for a bot older than all of them', () => {
    expect(pickViewerVersion('1.8.9', ['1.20.1', '1.21.4'])).toBe('1.20.1')
  })
})

describe('createBlockStateBridge', () => {
  it('passes everything through when both sides speak the same version', () => {
    const bridge = createBlockStateBridge(target, VIEWER_VERSION)

    expect(bridge.translating).toBe(false)
    expect(bridge.remapStateId(4329)).toBe(4329)
    expect(bridge.remapChunkJson('{"untouched":true}')).toBe('{"untouched":true}')
  })

  it('maps a drifted block onto its real counterpart', () => {
    // ROOT CAUSE:
    //
    // Block state ids are not stable across Minecraft versions. On 1.21.11 diamond_ore is state
    // 5106, but the 1.21.4 renderer reads 5106 as an entirely different block, and 1.21.4's
    // diamond_ore (4329) means redstone_wire on 1.21.11. Feeding raw ids to the viewer therefore
    // draws a world that does not exist — the failure this bridge is here to prevent.
    const bridge = createBlockStateBridge(source, VIEWER_VERSION)

    expect(sourceState('diamond_ore')).not.toBe(targetState('diamond_ore'))
    expect(bridge.remapStateId(sourceState('diamond_ore'))).toBe(targetState('diamond_ore'))
    expect(bridge.remapStateId(sourceState('crafting_table'))).toBe(targetState('crafting_table'))
  })

  it('leaves early blocks alone, since their ids never moved', () => {
    const bridge = createBlockStateBridge(source, VIEWER_VERSION)

    expect(bridge.remapStateId(sourceState('stone'))).toBe(targetState('stone'))
    expect(bridge.remapStateId(sourceState('grass_block'))).toBe(targetState('grass_block'))
    expect(bridge.remapStateId(0)).toBe(0)
  })

  it('preserves the state offset within a block, not just its default', () => {
    const bridge = createBlockStateBridge(source, VIEWER_VERSION)
    const oakLog = source.blocksByName.oak_log
    const targetOakLog = target.blocksByName.oak_log

    // oak_log has one state per axis; the second must stay the second, not collapse to the default.
    expect(bridge.remapStateId(oakLog.minStateId! + 1)).toBe(targetOakLog.minStateId! + 1)
  })

  it('substitutes stone for blocks the renderer has never heard of', () => {
    const bridge = createBlockStateBridge(source, VIEWER_VERSION)
    const addedLater = source.blocksArray.find(block => !target.blocksByName[block.name])

    expect(addedLater).toBeDefined()
    expect(bridge.coverage.blocksWithoutTwin).toBeGreaterThan(0)
    expect(bridge.remapStateId(addedLater!.defaultState!)).toBe(targetState('stone'))
  })

  it('reports how much of the source version survives the translation', () => {
    const bridge = createBlockStateBridge(source, VIEWER_VERSION)

    expect(bridge.translating).toBe(true)
    expect(bridge.sourceVersion).toBe(BOT_VERSION)
    expect(bridge.targetVersion).toBe(VIEWER_VERSION)
    expect(bridge.coverage.blocksMappedExactly).toBeGreaterThan(1000)
  })

  it('rewrites out-of-range ids to air rather than inventing a block', () => {
    const bridge = createBlockStateBridge(source, VIEWER_VERSION)

    expect(bridge.remapStateId(9_999_999)).toBe(0)
    expect(bridge.remapStateId(-1)).toBe(0)
  })
})

describe('createBlockStateBridge chunk translation', () => {
  const bridge = createBlockStateBridge(source, VIEWER_VERSION)

  it('translates a single-value section', () => {
    // NOTICE:
    // This fixture is hand-written because a locally built column cannot reach this state:
    // `SingleValueContainer` upgrades to an indirect palette on the first differing `set` and never
    // collapses back. Servers do send them — a section of solid stone or deepslate arrives this way
    // — so the branch is live in production even though only the network path produces it.
    // The shape below is verbatim `SingleValueContainer.toJson()` output.
    const single = JSON.stringify({
      worldHeight: WORLD_HEIGHT,
      minY: MIN_Y,
      sections: [JSON.stringify({
        data: JSON.stringify({
          type: 'single',
          value: sourceState('diamond_ore'),
          bitsPerValue: 4,
          capacity: 4096,
          maxBits: 8,
          maxBitsPerBlock: 15,
        }),
        solidBlockCount: 4096,
      })],
    })

    const after = JSON.parse(bridge.remapChunkJson(single)) as { sections: string[] }
    const storage = JSON.parse(JSON.parse(after.sections[0]).data) as Record<string, unknown>

    expect(storage.type).toBe('single')
    expect(storage.value).toBe(targetState('diamond_ore'))
    // Everything that is not a state id has to survive untouched.
    expect(storage.bitsPerValue).toBe(4)
    expect(storage.capacity).toBe(4096)
  })

  it('translates the palette of an indirect section', () => {
    const y = 64
    const column = buildColumn((setBlock) => {
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++)
          setBlock(x, y, z, sourceState('stone'))
      }

      setBlock(0, y, 0, sourceState('diamond_ore'))
      setBlock(1, y, 0, sourceState('crafting_table'))
    })

    const before = storageOf(column.toJson(), y)
    expect(before.type).toBe('indirect')
    expect(before.palette).toContain(sourceState('diamond_ore'))

    const after = storageOf(bridge.remapChunkJson(column.toJson()), y)
    expect(after.type).toBe('indirect')
    expect(after.palette).toContain(targetState('diamond_ore'))
    expect(after.palette).toContain(targetState('crafting_table'))
    expect(after.palette).toContain(targetState('stone'))
  })

  it('translates every packed value of a direct section', () => {
    // Direct storage kicks in past 256 distinct states in one section: there is no palette to patch,
    // so every value has to be unpacked from the bit array, mapped, and written back.
    const y = 64
    const placed: { x: number, y: number, z: number, name: string }[] = []
    const names = source.blocksArray
      .filter(block => target.blocksByName[block.name] && block.minStateId === block.maxStateId)
      .slice(0, 300)
      .map(block => block.name)

    expect(names.length).toBeGreaterThan(256)

    const column = buildColumn((setBlock) => {
      names.forEach((name, index) => {
        const position = { x: index % 16, y: y + Math.floor(index / 256), z: Math.floor(index / 16) % 16 }
        setBlock(position.x, position.y, position.z, sourceState(name))
        placed.push({ ...position, name })
      })
    })

    const original = storageOf(column.toJson(), y)
    expect(original.type).toBe('direct')

    // Reading prismarine-chunk's own output back with this decoder is what proves the packing
    // convention in `block-state-bridge` matches the writer's. If the bit layout were misread, the
    // state ids below would not line up with the blocks that were just placed.
    const beforeValues = decodePacked(original.data as string)
    for (const { x, y: blockY, z, name } of placed)
      expect(beforeValues[sectionBlockIndex(x, blockY, z)]).toBe(sourceState(name))

    const translated = storageOf(bridge.remapChunkJson(column.toJson()), y)
    expect(translated.type).toBe('direct')

    const afterValues = decodePacked(translated.data as string)
    for (const { x, y: blockY, z, name } of placed)
      expect(afterValues[sectionBlockIndex(x, blockY, z)]).toBe(targetState(name))
  })

  it('cannot be rendered by the viewer even so, because the reader drops direct sections', () => {
    // ROOT CAUSE:
    //
    // `DirectPaletteContainer`'s constructor allocates a fresh empty BitArray and ignores the
    // `data` option it is handed, so `fromJson` always yields an all-air section:
    //
    //   constructor (options) { this.data = new BitArray({ bitsPerValue: ..., capacity: ... }) }
    //
    // (`node_modules/prismarine-chunk/src/pc/common/PaletteContainer.js`, and the same minified code
    // sits in `prismarine-viewer/public/worker.js` — the sibling IndirectPaletteContainer *does*
    // honour `options.data`, which is why palette sections survive the trip.)
    //
    // This test pins the upstream behaviour rather than our own: a section dense enough to use
    // direct storage shows up in the render as empty air no matter what the bridge writes into it.
    // Translation is still applied so that a fixed reader would immediately render it correctly.
    const y = 64
    const column = buildColumn((setBlock) => {
      source.blocksArray
        .filter(block => block.minStateId === block.maxStateId)
        .slice(0, 300)
        .forEach((block, index) => {
          setBlock(index % 16, y + Math.floor(index / 256), Math.floor(index / 16) % 16, block.defaultState ?? 0)
        })
    })

    // NOTICE:
    // `static fromJson(j): typeof this` in prismarine-chunk's `types/index.d.ts` describes the
    // return as the class rather than an instance, so the value cannot be narrowed without going
    // through `unknown`. Runtime behaviour is unaffected; remove once upstream types the return as
    // an instance.
    const reloaded = chunkColumnFor(BOT_VERSION).fromJson(column.toJson()) as unknown as JavaChunkColumn
    expect(reloaded.getBlockStateId(new Vec3(0, y, 0))).toBe(0)
  })

  it('keeps biomes and block entities untouched while rewriting states', () => {
    const y = 64
    const column = buildColumn((setBlock) => {
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++)
          setBlock(x, y, z, sourceState('diamond_ore'))
      }
    })

    const before = JSON.parse(column.toJson()) as Record<string, unknown>
    const after = JSON.parse(bridge.remapChunkJson(column.toJson())) as Record<string, unknown>

    expect(after.biomes).toEqual(before.biomes)
    expect(after.blockEntities).toEqual(before.blockEntities)
    expect(after.skyLightSections).toEqual(before.skyLightSections)
    expect(after.minY).toBe(before.minY)
    expect(after.worldHeight).toBe(before.worldHeight)
  })
})
