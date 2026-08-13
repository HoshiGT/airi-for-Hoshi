import type { Bot } from 'mineflayer'

import type { Mineflayer } from '../libs/mineflayer'

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { env } from 'node:process'

import minecraftData from 'minecraft-data'
import PrismarineChunk from 'prismarine-chunk'

import { Vec3 } from 'vec3'
import { afterAll, describe, expect, it } from 'vitest'

import { config } from '../composables/config'
import { BotCamera } from './bot-camera'

// Launching Chromium and meshing chunks takes tens of seconds and needs the Playwright browser
// installed, so this stays opt-in: `RUN_VISION_RENDER_TEST=1 pnpm exec vitest run src/vision`.
const enabled = env.RUN_VISION_RENDER_TEST === '1'

// The loader's return type is a union of the Java and Bedrock implementations; this project only
// ever speaks Java, so narrowing it once here keeps every call site free of casts.
type JavaChunkColumnConstructor = Extract<
  ReturnType<typeof PrismarineChunk>,
  { prototype: { skyLightSent: boolean } }
>

function chunkColumnFor(version: string): JavaChunkColumnConstructor {
  return PrismarineChunk(version) as JavaChunkColumnConstructor
}

const BOT_VERSION = '1.21.11'
const GROUND_Y = 64
const MIN_Y = -64
const WORLD_HEIGHT = 384

const registry = minecraftData(BOT_VERSION)
const PLAINS_BIOME_ID = registry.biomesByName.plains.id
const stateOf = (name: string): number => registry.blocksByName[name]?.defaultState ?? 0

/**
 * A hand-built world with landmarks whose state ids drift between the bot's version and the
 * renderer's, so a translation failure shows up as a visibly wrong picture rather than a subtle one.
 */
function createTestWorld() {
  const ChunkColumn = chunkColumnFor(BOT_VERSION)
  const columns = new Map<string, ReturnType<typeof buildColumn>>()

  function buildColumn(chunkX: number, chunkZ: number) {
    const column = new ChunkColumn({ minY: MIN_Y, worldHeight: WORLD_HEIGHT })

    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        // Biome ids are not decoration here: grass and leaves are grey textures tinted per biome,
        // and an unset column defaults to biome 0 (badlands), which renders the whole world orange.
        for (let y = GROUND_Y - 8; y <= GROUND_Y + 8; y += 4)
          column.setBiome(new Vec3(x, y, z), PLAINS_BIOME_ID)

        for (let y = GROUND_Y - 8; y <= GROUND_Y; y++)
          column.setBlockStateId(new Vec3(x, y, z), y === GROUND_Y ? stateOf('grass_block') : stateOf('dirt'))
      }
    }

    // A wall of drifted blocks directly in front of the camera's spawn point.
    if (chunkX === 0 && chunkZ === 0) {
      const wall = ['diamond_block', 'gold_block', 'emerald_block', 'redstone_block', 'bricks']
      wall.forEach((name, index) => {
        for (let height = 1; height <= 3; height++)
          column.setBlockStateId(new Vec3(4 + index, GROUND_Y + height, 10), stateOf(name))
      })
    }

    return column
  }

  return {
    async getColumnAt(position: { x: number, z: number }) {
      const chunkX = Math.floor(position.x / 16)
      const chunkZ = Math.floor(position.z / 16)
      const key = `${chunkX},${chunkZ}`

      if (!columns.has(key))
        columns.set(key, buildColumn(chunkX, chunkZ))

      return columns.get(key)
    },
  }
}

/**
 * The smallest object the viewer feed and camera actually touch: a world, a body, a registry and an
 * event emitter. Standing this up avoids needing a live server to prove the render path works.
 */
function createStubBot(): Bot {
  const bot = new EventEmitter() as unknown as Bot & { world: unknown, registry: unknown }

  Object.assign(bot, {
    version: BOT_VERSION,
    username: 'render-test',
    registry,
    world: createTestWorld(),
    entities: {},
    entity: {
      position: new Vec3(6, GROUND_Y + 1, 2),
      yaw: Math.PI, // facing +Z, towards the wall
      pitch: 0,
      height: 1.8,
    },
  })

  return bot as Bot
}

describe.skipIf(!enabled)('botCamera rendering', () => {
  const camera = new BotCamera({ bot: createStubBot() } as unknown as Mineflayer)

  afterAll(async () => {
    await camera.dispose()
  })

  it('renders a frame of a 1.21.11 world through the 1.21.4 renderer', async () => {
    const result = await camera.capture()

    expect(result.width).toBe(config.vision.width)
    expect(result.height).toBe(config.vision.height)

    // ROOT CAUSE:
    //
    // Every capture used to burn the full 12s settle timeout and report `settled: false`, so the
    // model was told its picture might be incomplete when it never was.
    //
    // The mesh probe compared raw message counts: `dirty` messages sent versus `geometry` messages
    // received. Neither side is one-per-section — a block change dirties its neighbours too and the
    // worker collapses the repeats, while a dirty section in an unloaded chunk answers
    // `sectionFinished` with no geometry at all. On a live server the counters settled at roughly
    // 3920 queued against 784 finished and could never meet.
    //
    // The probe now mirrors `WorldRenderer.sectionsOutstanding`: a Set keyed by section, added on
    // `dirty` and removed on `sectionFinished`. Cold captures dropped 12.9s -> 3.7s, warm ones
    // 12.1s -> 48ms.
    expect(result.settled).toBe(true)

    const frame = camera.takePendingFrame()
    expect(frame).not.toBeNull()
    expect(frame!.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)

    // A blank sky-only frame compresses to almost nothing; a rendered world does not. This is the
    // cheapest assertion that separates "the renderer drew the world" from "WebGL silently failed".
    const bytes = Buffer.from(frame!.dataUrl.split(',')[1], 'base64').byteLength
    expect(bytes).toBeGreaterThan(8_000)

    expect(frame!.vantage.y).toBe(GROUND_Y + 1)
  }, 120_000)

  it('empties the mailbox once the frame has been handed over', async () => {
    expect(camera.hasPendingFrame()).toBe(false)
    expect(camera.takePendingFrame()).toBeNull()

    await camera.capture()
    expect(camera.hasPendingFrame()).toBe(true)
  }, 120_000)

  it('renders a third-person selfie with the bot model in frame', async () => {
    const result = await camera.selfie()

    expect(result.width).toBe(config.vision.width)
    expect(result.height).toBe(config.vision.height)
    expect(result.settled).toBe(true)

    // The stub bot has no logged-in client, so the skin resolves to null and the page keeps the
    // default Steve texture; the shot still must be framed and delivered.
    const frame = camera.takePendingFrame()
    expect(frame).not.toBeNull()
    expect(frame!.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)

    const bytes = Buffer.from(frame!.dataUrl.split(',')[1], 'base64').byteLength
    expect(bytes).toBeGreaterThan(8_000)

    // The bot stands at GROUND_Y + 1 and the camera frames from ~3.5 blocks in front of it; the
    // recorded vantage must be the bot's own position, not the camera's.
    expect(frame!.vantage.y).toBe(GROUND_Y + 1)
  }, 120_000)
})
