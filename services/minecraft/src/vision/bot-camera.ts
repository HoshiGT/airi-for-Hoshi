import type { Buffer } from 'node:buffer'

import type { Browser, Page } from 'playwright'

import type { Mineflayer } from '../libs/mineflayer'
import type { ViewerFeed } from './viewer-feed'

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { errorMessageFrom } from '@moeru/std'
import { chromium } from 'playwright'
import { supportedVersions } from 'prismarine-viewer'

import { config } from '../composables/config'
import { useLogger } from '../utils/logger'
import { createBlockStateBridge, pickViewerVersion } from './block-state-bridge'
import { startViewerFeed } from './viewer-feed'

/** Tuning for {@link BotCamera.renderFrame}; kept together because the values only make sense as a set. */
const FRAME_SETTLE = {
  /** How often the mesh counters are read back out of the page. */
  pollMs: 150,
  /** Silence after the last meshing message that counts as "the view stopped changing". */
  quietMs: 350,
  /** Give up waiting for a complete view after this long and send what there is. */
  timeoutMs: 12_000,
  /** High enough that block textures stay readable; the frame is judged by a model, not a person. */
  jpegQuality: 85,
} as const

/**
 * Rebuilds the renderer's own "sections still outstanding" bookkeeping by wrapping `Worker` before
 * the viewer bundle creates any.
 *
 * NOTICE:
 * The renderer already tracks this in `WorldRenderer.sectionsOutstanding` and even exposes
 * `viewer.waitForChunksToRender()`, but the bundled page keeps its `viewer` instance in a module
 * scope with nothing published to `window`
 * (`prismarine-viewer/lib/index.js`), so there is no way to call it from the outside. Observing the
 * worker traffic reconstructs the same signal without patching the package.
 *
 * The accounting has to match `WorldRenderer` exactly, and the two obvious shortcuts both fail
 * (`prismarine-viewer@1.33.0/viewer/lib/worldrenderer.js:150-161`,
 * `viewer/lib/worker.js:26-87`):
 *
 * - One section is marked dirty repeatedly — a block change also dirties its neighbours — and the
 *   worker collapses those into one job, so counting `dirty` messages over-counts the work. Both
 *   sides key by section instead.
 * - A dirty section whose chunk is not loaded answers `sectionFinished` with no `geometry` at all,
 *   so counting `geometry` replies under-counts completions and the two counters never meet.
 *
 * `geometry` is still counted, but only as evidence that the page has drawn *something*; see
 * {@link BotCamera.renderFrame}.
 *
 * Must run as an init script: it has to replace `Worker` before the bundle's first `new Worker`.
 */
const MESH_PROBE_SCRIPT = `(() => {
  const outstanding = new Set()
  let meshed = 0
  let lastActivityAt = Date.now()

  // Same key WorldRenderer.setSectionDirty and the worker's setSectionDirty derive.
  const sectionKey = (x, y, z) =>
    Math.floor(x / 16) * 16 + ',' + Math.floor(y / 16) * 16 + ',' + Math.floor(z / 16) * 16

  // A function, not an object: the Set has to stay inside the page, only its size crosses over.
  window.__airiMeshProgress = () => ({ outstanding: outstanding.size, meshed, lastActivityAt })

  const NativeWorker = window.Worker
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args)
      this.addEventListener('message', (event) => {
        const data = event && event.data
        if (!data)
          return

        if (data.type === 'sectionFinished') {
          outstanding.delete(data.key)
          lastActivityAt = Date.now()
        }
        else if (data.type === 'geometry') {
          meshed++
          lastActivityAt = Date.now()
        }
      })
    }

    postMessage(message, ...rest) {
      if (message && message.type === 'dirty') {
        outstanding.add(sectionKey(message.x, message.y, message.z))
        lastActivityAt = Date.now()
      }
      return super.postMessage(message, ...rest)
    }
  }
})()`

/** Where the newest frame is mirrored for humans; see BotCamera.saveDebugFrame. */
const LATEST_FRAME_PATH = join('data', 'vision', 'latest.jpg')

/** A rendered first-person frame waiting to be shown to the model. */
export interface VisionFrame {
  /** `data:image/jpeg;base64,...`, ready to drop into a chat image content part. */
  dataUrl: string
  width: number
  height: number
  capturedAt: number
  /** Where the bot stood and looked when the frame was rendered. */
  vantage: { x: number, y: number, z: number, yaw: number, pitch: number }
}

export interface CaptureResult {
  width: number
  height: number
  /** Wall-clock cost of this capture, including any cold start. */
  durationMs: number
  /** True when the renderer was still meshing chunks and the frame may be incomplete. */
  settled: boolean
}

/**
 * The bot's eyes.
 *
 * Owns a prismarine-viewer feed and a headless Chromium page kept alive between captures, so the
 * first capture pays for a browser launch and chunk meshing (seconds) while later ones only pay for
 * a screenshot (tens of milliseconds) plus whatever new chunks moved into view.
 *
 * Nothing starts until {@link BotCamera.capture} is called for the first time: a bot that never
 * looks costs nothing.
 *
 * Captured frames are held in a one-slot mailbox rather than returned to the caller, because the
 * caller is sandboxed LLM-authored JavaScript that can only receive plain data. The brain drains the
 * mailbox with {@link BotCamera.takePendingFrame} and attaches the image to its next request.
 *
 * Call stack:
 *
 * look tool (cognitive/action/llm-actions)
 *   -> {@link BotCamera.capture}
 *     -> {@link startViewerFeed} (bot world -> viewer web server)
 *       -> {@link BotCamera.renderFrame} (headless page -> JPEG)
 *         -> {@link BotCamera.takePendingFrame} (brain, next turn)
 */
export class BotCamera {
  private readonly mineflayer: Mineflayer
  private readonly logger = useLogger()

  private feed: ViewerFeed | null = null
  private browser: Browser | null = null
  private page: Page | null = null
  private startup: Promise<void> | null = null
  private pendingFrame: VisionFrame | null = null
  /** Set once the renderer has meshed anything at all; see {@link BotCamera.renderFrame}. */
  private warmedUp = false

  constructor(mineflayer: Mineflayer) {
    this.mineflayer = mineflayer
  }

  /**
   * Renders what the bot is looking at right now and parks it for the next LLM turn.
   *
   * Throws when the renderer cannot be brought up at all (missing browser binary, busy port); the
   * caller turns that into a structured tool failure so the model can carry on without vision.
   */
  async capture(): Promise<CaptureResult> {
    const startedAt = Date.now()
    await this.ensureStarted()

    const page = this.page
    const feed = this.feed
    if (!page || !feed)
      throw new Error('Vision renderer is not running')

    // The camera only follows the bot through `move` events, so a bot that turned its head without
    // walking would otherwise be photographed facing the wrong way.
    feed.pushPosition()

    const { image, settled } = await this.renderFrame(page)
    const entity = this.mineflayer.bot.entity

    this.pendingFrame = {
      dataUrl: `data:image/jpeg;base64,${image.toString('base64')}`,
      width: config.vision.width,
      height: config.vision.height,
      capturedAt: Date.now(),
      vantage: {
        x: Math.round(entity.position.x * 10) / 10,
        y: Math.round(entity.position.y * 10) / 10,
        z: Math.round(entity.position.z * 10) / 10,
        yaw: Math.round(entity.yaw * 100) / 100,
        pitch: Math.round(entity.pitch * 100) / 100,
      },
    }

    await this.saveDebugFrame(image)

    return {
      width: config.vision.width,
      height: config.vision.height,
      durationMs: Date.now() - startedAt,
      settled,
    }
  }

  /** Returns the frame waiting to be sent and clears the slot. */
  takePendingFrame(): VisionFrame | null {
    const frame = this.pendingFrame
    this.pendingFrame = null
    return frame
  }

  hasPendingFrame(): boolean {
    return this.pendingFrame !== null
  }

  async dispose(): Promise<void> {
    this.pendingFrame = null
    this.startup = null

    const page = this.page
    const browser = this.browser
    const feed = this.feed
    this.page = null
    this.browser = null
    this.feed = null

    try {
      await page?.close()
      await browser?.close()
    }
    catch (error) {
      this.logger.warn(`Vision: failed to close the headless browser cleanly: ${errorMessageFrom(error)}`)
    }

    feed?.close()
  }

  /** Boots the feed and browser once; concurrent captures share the same startup. */
  private async ensureStarted(): Promise<void> {
    if (this.page)
      return

    this.startup ??= this.start().catch((error) => {
      // A failed start must not poison later attempts: the port may free up, or the browser may be
      // installed while the bot keeps running.
      this.startup = null
      throw error
    })

    return this.startup
  }

  private async start(): Promise<void> {
    const bot = this.mineflayer.bot
    const targetVersion = pickViewerVersion(bot.version, supportedVersions)
    const bridge = createBlockStateBridge(bot.registry, targetVersion)

    if (bridge.translating) {
      this.logger.log(
        `Vision: rendering ${bridge.sourceVersion} world with the ${bridge.targetVersion} renderer `
        + `(${bridge.coverage.blocksMappedExactly} blocks mapped exactly, `
        + `${bridge.coverage.blocksWithChangedStates} collapsed to their default state, `
        + `${bridge.coverage.blocksWithoutTwin} without a counterpart)`,
      )
    }

    this.feed = await startViewerFeed(bot, {
      port: config.vision.port,
      viewDistance: config.vision.viewDistance,
      bridge,
    })

    this.browser = await chromium.launch({
      // NOTICE:
      // Software rendering is mandatory here. The bot runs headless with no GPU access, and
      // three.js needs a real WebGL context; without these flags Chromium falls back to a stub
      // context and every frame comes out blank.
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
      ],
    })

    this.page = await this.browser.newPage({
      viewport: { width: config.vision.width, height: config.vision.height },
    })

    this.page.on('pageerror', error => this.logger.warn(`Vision: renderer page error: ${errorMessageFrom(error)}`))

    await this.page.addInitScript(MESH_PROBE_SCRIPT)
    await this.page.goto(`http://127.0.0.1:${this.feed.port}`, { waitUntil: 'load' })
    this.feed.pushPosition()

    this.logger.log(`Vision: renderer ready on port ${this.feed.port}`)
  }

  /**
   * Screenshots the page once the renderer has finished building the geometry it was asked for.
   *
   * ROOT CAUSE for not simply comparing consecutive frames:
   *
   * A blank page is perfectly stable. The first capture after startup would compare two identical
   * empty frames, call that "settled", and hand the model a picture of nothing — exactly the
   * failure mode that vision is supposed to remove. Waiting a fixed few seconds instead would be
   * both slower than needed and still a guess.
   *
   * So readiness comes from the renderer's own bookkeeping, observed through
   * {@link MESH_PROBE_SCRIPT}: no sections left outstanding, plus a quiet moment, means the view is
   * as complete as it is going to get.
   */
  private async renderFrame(page: Page): Promise<{ image: Buffer, settled: boolean }> {
    // A cold page has drawn nothing yet, so "no work outstanding" is not evidence of a finished
    // view until at least one section has actually been meshed.
    const requireMeshedWork = !this.warmedUp
    const deadline = Date.now() + FRAME_SETTLE.timeoutMs

    while (Date.now() < deadline) {
      const stats = await readMeshProgress(page)

      const idle = stats !== null
        && stats.outstanding === 0
        && Date.now() - stats.lastActivityAt > FRAME_SETTLE.quietMs
      const hasDrawnSomething = stats !== null && stats.meshed > 0

      if (idle && (hasDrawnSomething || !requireMeshedWork)) {
        this.warmedUp = true
        return { image: await this.shoot(page), settled: true }
      }

      await new Promise(resolve => setTimeout(resolve, FRAME_SETTLE.pollMs))
    }

    // Out of time. A partly meshed world still tells the model more than an error does, so the
    // frame is sent with `settled: false` and the tool says so in its result.
    this.logger.warn('Vision: the renderer did not finish meshing in time; sending a partial frame')
    return { image: await this.shoot(page), settled: false }
  }

  private shoot(page: Page): Promise<Buffer> {
    return page.screenshot({ type: 'jpeg', quality: FRAME_SETTLE.jpegQuality })
  }

  /**
   * Mirrors the newest frame to disk so a human can see exactly what the bot saw.
   *
   * Deliberately a single overwritten file: this is a debugging window, not a history, and an
   * unbounded folder of frames would quietly fill the disk of a bot that likes to look around.
   */
  private async saveDebugFrame(image: Buffer): Promise<void> {
    try {
      await mkdir(dirname(LATEST_FRAME_PATH), { recursive: true })
      await writeFile(LATEST_FRAME_PATH, image)
    }
    catch (error) {
      this.logger.warn(`Vision: could not write the debug frame: ${errorMessageFrom(error)}`)
    }
  }
}

interface MeshProgress {
  /** Sections marked dirty whose worker has not reported back yet. */
  outstanding: number
  /** Sections that produced actual geometry; 0 means the page has drawn nothing at all. */
  meshed: number
  lastActivityAt: number
}

/** Reads the mesh counters, or null if the probe never installed (page navigating, bundle changed). */
async function readMeshProgress(page: Page): Promise<MeshProgress | null> {
  try {
    return await page.evaluate<MeshProgress | null>('window.__airiMeshProgress ? window.__airiMeshProgress() : null')
  }
  catch {
    // The page can be mid-navigation or closed underneath us; treat it as "no signal yet".
    return null
  }
}

let activeCamera: { camera: BotCamera, bot: unknown } | null = null

/**
 * Returns the camera for the current bot, creating it on first use.
 *
 * Reconnects replace the underlying mineflayer bot object; the previous camera is bound to a dead
 * connection, so it is torn down and replaced rather than reused.
 */
export function useBotCamera(mineflayer: Mineflayer): BotCamera {
  if (activeCamera && activeCamera.bot === mineflayer.bot)
    return activeCamera.camera

  const previous = activeCamera
  if (previous) {
    void previous.camera.dispose().catch(() => {
      // The old browser is already unreachable in every case that gets us here; there is nothing
      // useful left to do about a failed teardown.
    })
  }

  const camera = new BotCamera(mineflayer)
  activeCamera = { camera, bot: mineflayer.bot }
  return camera
}

/**
 * Hands over the frame the bot most recently rendered, if one is waiting.
 *
 * Returns null when the camera has never been used, so the brain can ask on every turn without
 * bringing a renderer to life.
 */
export function takePendingVisionFrame(): VisionFrame | null {
  return activeCamera?.camera.takePendingFrame() ?? null
}

/** Whether a rendered frame is waiting to be delivered to the model. */
export function hasPendingVisionFrame(): boolean {
  return activeCamera?.camera.hasPendingFrame() ?? false
}

/** Tears down the camera, if any. Safe to call when vision was never used. */
export async function disposeBotCamera(): Promise<void> {
  const current = activeCamera
  activeCamera = null
  await current?.camera.dispose()
}
