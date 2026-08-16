import type { IndexedData } from 'minecraft-data'

import minecraftData from 'minecraft-data'

/**
 * Translates block state ids from the version the bot speaks into the newest version the
 * prismarine-viewer browser bundle knows how to render.
 *
 * The viewer ships a fixed block model/texture set per Minecraft version and refuses any version
 * it was not built for. Its newest is 1.21.4 (npm `prismarine-viewer@1.33.0`, no newer release),
 * while the bot may be on any 1.21.x. Ids are not stable across those releases: on 1.21.11
 * `diamond_ore` is state 5106, and feeding that number to a 1.21.4 renderer draws `redstone_wire`.
 * 961 of 1095 blocks shift between those two versions, so an untranslated feed is not "slightly
 * off" — it is a hallucinated world, which is worse than no picture at all for a model that is
 * supposed to act on what it sees.
 */
export interface BlockStateBridge {
  readonly sourceVersion: string
  readonly targetVersion: string
  /** False when both versions agree and every call is a pass-through. */
  readonly translating: boolean
  readonly coverage: BridgeCoverage
  /** Maps one source state id; unknown ids fall back to air so nothing is invented. */
  remapStateId: (stateId: number) => number
  /**
   * Rewrites a serialized chunk column so every block state id inside it is expressed in the
   * target version. Input and output are `ChunkColumn.toJson()` strings.
   */
  remapChunkJson: (json: string) => string
}

/** How faithfully the source version can be expressed in the target version. */
export interface BridgeCoverage {
  /** Blocks that do not exist in the target version at all (added in a later release). */
  blocksWithoutTwin: number
  /** Blocks whose property set changed, so only the default state can be mapped. */
  blocksWithChangedStates: number
  /** Blocks translated state-for-state. */
  blocksMappedExactly: number
}

/**
 * Picks the best viewer version for a bot version: the exact match when the viewer supports it,
 * otherwise the newest supported version that is not newer than the bot's.
 *
 * Older-than-everything bot versions get the oldest supported version rather than an error —
 * a slightly wrong picture beats no vision, and every alternative here is also approximate.
 */
export function pickViewerVersion(botVersion: string, supportedVersions: readonly string[]): string {
  if (supportedVersions.includes(botVersion))
    return botVersion

  // `dataVersion` increases monotonically across releases, unlike the dotted version string
  // (which does not sort lexicographically: "1.21.11" < "1.21.4").
  const ranked = supportedVersions
    .map(version => ({ version, dataVersion: dataVersionOf(version) }))
    .filter((entry): entry is { version: string, dataVersion: number } => entry.dataVersion !== null)
    .sort((a, b) => a.dataVersion - b.dataVersion)

  if (ranked.length === 0)
    throw new Error('prismarine-viewer reported no usable supported versions')

  const botDataVersion = dataVersionOf(botVersion)
  if (botDataVersion === null)
    return ranked[ranked.length - 1].version

  const olderOrEqual = ranked.filter(entry => entry.dataVersion <= botDataVersion)
  return olderOrEqual.length > 0
    ? olderOrEqual[olderOrEqual.length - 1].version
    : ranked[0].version
}

function dataVersionOf(version: string): number | null {
  try {
    return minecraftData(version)?.version?.dataVersion ?? null
  }
  catch {
    return null
  }
}

/**
 * Builds the translation table between two Minecraft versions.
 *
 * `sourceRegistry` should be the live `bot.registry`, so the table is built against exactly the
 * data the server negotiated rather than a version string parsed twice.
 */
export function createBlockStateBridge(sourceRegistry: IndexedData, targetVersion: string): BlockStateBridge {
  const sourceVersion = sourceRegistry.version.minecraftVersion ?? String(sourceRegistry.version.majorVersion)

  if (sourceVersion === targetVersion) {
    return {
      sourceVersion,
      targetVersion,
      translating: false,
      coverage: { blocksWithoutTwin: 0, blocksWithChangedStates: 0, blocksMappedExactly: 0 },
      remapStateId: stateId => stateId,
      remapChunkJson: json => json,
    }
  }

  const target = minecraftData(targetVersion)
  const { table, coverage } = buildStateTable(sourceRegistry, target)

  // Out-of-range ids can only come from a desync between the registry we built the table from and
  // the data actually arriving. Air is the one choice that cannot fabricate a block that is not there.
  const remapStateId = (stateId: number): number =>
    stateId >= 0 && stateId < table.length ? table[stateId] : 0

  return {
    sourceVersion,
    targetVersion,
    translating: true,
    coverage,
    remapStateId,
    remapChunkJson: json => remapColumn(json, remapStateId),
  }
}

function buildStateTable(source: IndexedData, target: IndexedData): { table: Int32Array, coverage: BridgeCoverage } {
  const maxSourceState = source.blocksArray.reduce((max, block) => Math.max(max, block.maxStateId ?? 0), 0)
  const table = new Int32Array(maxSourceState + 1)

  // Blocks that only exist in the newer version have to become *something*. Stone reads as
  // "solid, unremarkable" to a model, which is the least misleading guess available: it will not
  // suggest a chest to open or an ore to mine that is not really there.
  const substitute = target.blocksByName.stone?.defaultState ?? 0
  const coverage: BridgeCoverage = { blocksWithoutTwin: 0, blocksWithChangedStates: 0, blocksMappedExactly: 0 }

  for (const block of source.blocksArray) {
    const minStateId = block.minStateId ?? 0
    const maxStateId = block.maxStateId ?? minStateId
    const twin = target.blocksByName[block.name]

    if (!twin) {
      coverage.blocksWithoutTwin++
      table.fill(substitute, minStateId, maxStateId + 1)
      continue
    }

    const twinMinStateId = twin.minStateId ?? 0
    const twinMaxStateId = twin.maxStateId ?? twinMinStateId

    // States are laid out as a dense block per block type, in property order. That layout only
    // lines up when both versions expose the same properties, so an unequal count means the
    // per-state offset would land on an unrelated variant.
    if (maxStateId - minStateId !== twinMaxStateId - twinMinStateId) {
      coverage.blocksWithChangedStates++
      table.fill(twin.defaultState ?? twinMinStateId, minStateId, maxStateId + 1)
      continue
    }

    coverage.blocksMappedExactly++
    for (let stateId = minStateId; stateId <= maxStateId; stateId++)
      table[stateId] = twinMinStateId + (stateId - minStateId)
  }

  return { table, coverage }
}

// ─── chunk column surgery ────────────────────────────────────────────────
//
// `ChunkColumn.toJson()` nests JSON inside JSON: the column holds section strings, each section
// holds a storage string, and a direct-storage section holds a packed BitArray string. We walk down
// to whichever layer actually carries state ids and rewrite only that, so biomes, lighting and
// block entities survive the trip untouched.

interface SerializedColumn {
  sections: string[]
  [key: string]: unknown
}

interface SerializedSection {
  data: string
  [key: string]: unknown
}

/** One of the three storage strategies `PaletteContainer` uses, by unique-state count. */
type SerializedStorage
  = | { type: 'single', value: number, [key: string]: unknown }
    | { type: 'indirect', palette: number[], [key: string]: unknown }
    | { type: 'direct', data: string, [key: string]: unknown }

function remapColumn(json: string, remapStateId: (stateId: number) => number): string {
  const column = JSON.parse(json) as SerializedColumn

  column.sections = column.sections.map((sectionJson) => {
    const section = JSON.parse(sectionJson) as SerializedSection
    const storage = JSON.parse(section.data) as SerializedStorage

    if (storage.type === 'single')
      storage.value = remapStateId(storage.value)
    else if (storage.type === 'indirect')
      storage.palette = storage.palette.map(remapStateId)
    else
      storage.data = remapPackedStates(storage.data, remapStateId)

    section.data = JSON.stringify(storage)
    return JSON.stringify(section)
  })

  return JSON.stringify(column)
}

interface SerializedBitArray {
  data: number[]
  capacity: number
  bitsPerValue: number
  valuesPerLong: number
  valueMask: number
}

/**
 * Rewrites the state ids of a direct-storage section in place.
 *
 * Direct storage appears only when a single 16³ section holds more distinct states than the
 * palette can index (>256), which in practice means a dense build rather than terrain. There is no
 * palette to patch, so every packed value is decoded and re-encoded individually.
 *
 * The bit layout is left exactly as it was found — same `bitsPerValue`, same word count — because
 * target ids are smaller than the source's bit width in every version pair the viewer supports.
 * Rewriting values in place keeps this independent of how the writer chose to size the array.
 *
 * NOTICE:
 * Sections in this form currently render as empty air whatever we write into them, because
 * `DirectPaletteContainer`'s constructor allocates a fresh BitArray and ignores the `data` it was
 * given — so `fromJson` reconstructs nothing. That code ships both in prismarine-chunk
 * (`src/pc/common/PaletteContainer.js`) and, minified, inside the renderer's own bundle
 * (`prismarine-viewer/public/worker.js`); its indirect-palette sibling honours `options.data`,
 * which is why every other section survives. The translation below is kept because it is correct
 * and cheap, and a fixed reader would then render these sections properly with no further work.
 *
 * The packing mirrors `BitArrayNoSpan` in prismarine-chunk, which is what `PaletteContainer` uses
 * for every container type (`node_modules/prismarine-chunk/src/pc/common/PaletteContainer.js:1`).
 * A value never straddles a 64-bit boundary, but it may straddle the two 32-bit words that make up
 * one long, which is why both halves are handled below.
 */
function remapPackedStates(json: string, remapStateId: (stateId: number) => number): string {
  const bits = JSON.parse(json) as SerializedBitArray
  const words = Uint32Array.from(bits.data)
  const { capacity, bitsPerValue, valuesPerLong, valueMask } = bits

  for (let index = 0; index < capacity; index++) {
    const value = readPacked(words, index, bitsPerValue, valuesPerLong, valueMask)
    writePacked(words, index, remapStateId(value), bitsPerValue, valuesPerLong, valueMask)
  }

  bits.data = Array.from(words)
  return JSON.stringify(bits)
}

function readPacked(words: Uint32Array, index: number, bitsPerValue: number, valuesPerLong: number, valueMask: number): number {
  const longIndex = Math.floor(index / valuesPerLong)
  const bitOffset = (index - longIndex * valuesPerLong) * bitsPerValue

  // The upper 32-bit word of the long holds this value outright.
  if (bitOffset >= 32)
    return (words[longIndex * 2 + 1] >>> (bitOffset - 32)) & valueMask

  let result = words[longIndex * 2] >>> bitOffset
  if (bitOffset + bitsPerValue > 32)
    result |= words[longIndex * 2 + 1] << (32 - bitOffset) // spills into the upper word

  return result & valueMask
}

function writePacked(words: Uint32Array, index: number, value: number, bitsPerValue: number, valuesPerLong: number, valueMask: number): void {
  const longIndex = Math.floor(index / valuesPerLong)
  const bitOffset = (index - longIndex * valuesPerLong) * bitsPerValue
  const masked = value & valueMask

  if (bitOffset >= 32) {
    const shift = bitOffset - 32
    words[longIndex * 2 + 1] = ((words[longIndex * 2 + 1] & ~(valueMask << shift)) | (masked << shift)) >>> 0
    return
  }

  words[longIndex * 2] = ((words[longIndex * 2] & ~(valueMask << bitOffset)) | (masked << bitOffset)) >>> 0

  const endBitOffset = bitOffset + bitsPerValue
  if (endBitOffset > 32) {
    const spilledBits = endBitOffset - 32
    words[longIndex * 2 + 1] = ((words[longIndex * 2 + 1] & ~((1 << spilledBits) - 1)) | (masked >>> (32 - bitOffset))) >>> 0
  }
}
