import type { Buffer } from 'node:buffer'

import type { Browser, Page } from 'playwright'

import type { Mineflayer } from '../libs/mineflayer'
import type { BlockStateBridge } from './block-state-bridge'
import type { ViewerFeed } from './viewer-feed'

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// NOTICE:
// Default import, then read the property — the named import fails at link time.
//
// prismarine-viewer is CommonJS and assigns this one inside an object literal:
// `supportedVersions: require('./viewer').supportedVersions` (index.js:6). Node's
// cjs-module-lexer only recognises statically analysable assignments, so it never
// lists `supportedVersions` among the named exports, and
// `import { supportedVersions } from 'prismarine-viewer'` throws
// "does not provide an export named" before any code runs — taking the whole bot
// down at startup, not just vision. Sibling `mineflayer` is detected and would
// have worked, which is what makes the failure look arbitrary.
//
// Removal condition: prismarine-viewer ships ESM or a static re-export.
import prismarineViewer from 'prismarine-viewer'

import { errorMessageFrom } from '@moeru/std'
import { chromium } from 'playwright'

import { config } from '../composables/config'
import { useLogger } from '../utils/logger'
import { createBlockStateBridge, pickViewerVersion } from './block-state-bridge'
import { fetchBotSkinDataUrl } from './bot-skin'
import { startViewerFeed, VIEWER_HOOK_SCRIPT } from './viewer-feed'

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

/**
 * Where the newest selfie frame is mirrored; kept apart from {@link LATEST_FRAME_PATH} so both
 * views stay inspectable.
 */
const SELFIE_FRAME_PATH = join('data', 'vision', 'latest-selfie.jpg')

/** What `SELFIE_POSE_SCRIPT` is told about the shot it should compose. */
interface SelfiePose {
  x: number
  y: number
  z: number
  yaw: number
  /**
   * `data:image/png;base64,...` of the bot's real skin, or null to keep the default Steve texture
   * (offline accounts, unpublished skins).
   */
  skin: string | null
}

/**
 * Runs inside the renderer page: finds the bot's third-person model, dresses it in the real skin
 * and moves the orbit camera to frame it from the front.
 *
 * The page owns the model: prismarine-viewer creates it in third-person mode as an `Object3D`
 * holding one `THREE.SkinnedMesh` with the hardcoded Steve texture, tweened to the bot's position
 * and yaw. Other players stream in as the same shape, so the bot's own model is picked by distance
 * to the known bot position — and refused when the closest candidate is far away, because that
 * means the model has not been created/tweened yet (it spawns at the origin).
 *
 * The camera convention mirrors `viewer.setFirstPersonCamera`: rotation.y = yaw, forward = -Z
 * rotated by yaw, so the camera is placed along the direction the model actually faces. The
 * orbit controls re-apply `position = target + offset` and `lookAt(target)` on every frame, so the
 * shot is framed by moving their `target` to the face rather than by fighting them with a single
 * `lookAt`.
 *
 * Restore state is saved only once, before the first pose of a series: retries that re-enter after
 * a missed model must still return the camera to where it was before the *first* attempt.
 */
const SELFIE_POSE_SCRIPT = `(opts) => {
  const exposed = window.__airiViewer
  if (!exposed || !exposed.THREE || !exposed.scene || !exposed.camera)
    return { exposed: false, found: false }

  const THREE = exposed.THREE

  if (!window.__airiSelfieRestore) {
    const savedPosition = exposed.camera.position.clone()
    const savedQuaternion = exposed.camera.quaternion.clone()
    const savedTarget = exposed.controls ? exposed.controls.target.clone() : null
    window.__airiSelfieRestore = () => {
      exposed.camera.position.copy(savedPosition)
      exposed.camera.quaternion.copy(savedQuaternion)
      if (exposed.controls && savedTarget)
        exposed.controls.target.copy(savedTarget)
    }
  }

  const botPosition = new THREE.Vector3(opts.x, opts.y, opts.z)
  let botRoot = null
  let bestDistance = Infinity
  for (const child of exposed.scene.children) {
    if (child.type !== 'Object3D')
      continue
    if (!child.children.some(mesh => mesh.isSkinnedMesh === true))
      continue
    const distance = child.position.distanceToSquared(botPosition)
    if (distance < bestDistance) {
      bestDistance = distance
      botRoot = child
    }
  }
  // More than a few blocks away means the model has not appeared/tweened yet, or the nearest
  // candidate is somebody else; texturing either would be wrong.
  const found = botRoot !== null && bestDistance < 16

  const faceDirection = new THREE.Vector3(-Math.sin(opts.yaw), 0, -Math.cos(opts.yaw))
  const cameraPosition = botPosition.clone().addScaledVector(faceDirection, 3.5)
  cameraPosition.y += 1.6
  const facePoint = new THREE.Vector3(opts.x, opts.y + 1.5, opts.z)

  if (exposed.controls)
    exposed.controls.target.copy(facePoint)
  exposed.camera.position.copy(cameraPosition)
  exposed.camera.lookAt(facePoint)

  const applySkin = async () => {
    if (!opts.skin || !found)
      return

    const mesh = botRoot.children.find(child => child.isSkinnedMesh === true)
    if (!mesh)
      return

    try {
      const texture = await Promise.race([
        new Promise((resolve, reject) => {
          new THREE.TextureLoader().load(opts.skin, resolve, undefined, reject)
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 5000)),
      ])
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      texture.flipY = false
      texture.wrapS = THREE.RepeatWrapping
      texture.wrapT = THREE.RepeatWrapping
      mesh.material.map = texture
      mesh.material.needsUpdate = true
    }
    catch (error) {
      console.warn('Selfie: skin texture failed to load, keeping the default skin:', error)
    }
  }

  // Two animation frames: the swapped texture and moved camera only reach the canvas after the
  // page's own render loop has run with them.
  const waitFrames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

  return applySkin().then(waitFrames).then(() => ({ exposed: true, found }))
}`

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
 * look / selfie tools (cognitive/action/llm-actions)
 *   -> {@link BotCamera.capture} / {@link BotCamera.selfie}
 *     -> {@link startViewerFeed} (bot world -> viewer web server)
 *       -> {@link BotCamera.waitForSettle} (headless page -> JPEG)
 *         -> {@link BotCamera.takePendingFrame} (brain, next turn)
 */
export class BotCamera {
  private readonly mineflayer: Mineflayer
  private readonly logger = useLogger()

  private bridge: BlockStateBridge | null = null
  private feed: ViewerFeed | null = null
  private browser: Browser | null = null
  private page: Page | null = null
  private startup: Promise<void> | null = null

  private selfieFeed: ViewerFeed | null = null
  private selfieBrowser: Browser | null = null
  private selfiePage: Page | null = null
  private selfieStartup: Promise<void> | null = null

  /** The bot's skin as a data URL, resolved at most once per camera session; see resolveSkin. */
  private skinDataUrl: string | null = null
  private skinResolved = false

  private pendingFrame: VisionFrame | null = null
  /** Set per page once the renderer has meshed anything at all; see {@link BotCamera.waitForSettle}. */
  private readonly warmedUp = new WeakMap<Page, boolean>()

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

    await this.saveDebugFrame(image)

    return this.deliverFrame(image, startedAt, settled)
  }

  /**
   * Renders the bot from the outside — a third-person view of its real Minecraft skin, framed from
   * the front a few blocks away — and parks it for the next LLM turn.
   *
   * Runs on a separate third-person viewer feed, because the first-person page never creates the
   * bot model at all (it binds the camera to the bot's eyes and returns early). The skin is fetched
   * once from the Mojang sessionserver; offline accounts keep the default Steve texture.
   *
   * Throws when the renderer cannot be brought up at all; the caller turns that into a structured
   * tool failure so the model can carry on without vision.
   */
  async selfie(): Promise<CaptureResult> {
    const startedAt = Date.now()
    await this.ensureSelfieStarted()

    const page = this.selfiePage
    const feed = this.selfieFeed
    if (!page || !feed)
      throw new Error('Selfie renderer is not running')

    // Both drives the page's orbit camera on a fresh connection and tweens the bot model to where
    // the bot stands right now.
    feed.pushPosition()

    const settled = await this.waitForSettle(page)

    const skin = await this.resolveSkin()
    await this.poseSelfie(page, feed, {
      x: this.mineflayer.bot.entity.position.x,
      y: this.mineflayer.bot.entity.position.y,
      z: this.mineflayer.bot.entity.position.z,
      yaw: this.mineflayer.bot.entity.yaw,
      skin,
    })

    const image = await this.shoot(page)

    await this.restoreSelfieCamera(page)

    await this.saveDebugFrame(image, SELFIE_FRAME_PATH)

    return this.deliverFrame(image, startedAt, settled)
  }

  /** Fills the mailbox slot shared by `look` and `selfie`; the brain drains it on the next turn. */
  private deliverFrame(image: Buffer, startedAt: number, settled: boolean): CaptureResult {
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
    this.selfieStartup = null

    const sessions = [
      { page: this.page, browser: this.browser, feed: this.feed },
      { page: this.selfiePage, browser: this.selfieBrowser, feed: this.selfieFeed },
    ]
    this.page = null
    this.browser = null
    this.feed = null
    this.selfiePage = null
    this.selfieBrowser = null
    this.selfieFeed = null

    for (const session of sessions) {
      try {
        await session.page?.close()
        await session.browser?.close()
      }
      catch (error) {
        this.logger.warn(`Vision: failed to close the headless browser cleanly: ${errorMessageFrom(error)}`)
      }

      session.feed?.close()
    }
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

  /** Boots the selfie feed and browser once; concurrent selfies share the same startup. */
  private async ensureSelfieStarted(): Promise<void> {
    if (this.selfiePage)
      return

    this.selfieStartup ??= this.startSelfie().catch((error) => {
      // Same policy as ensureStarted: a failed start must not poison later attempts.
      this.selfieStartup = null
      throw error
    })

    return this.selfieStartup
  }

  /** Builds the block-state translation once and shares it between the two feeds. */
  private async ensureBridge(): Promise<BlockStateBridge> {
    if (this.bridge)
      return this.bridge

    const bot = this.mineflayer.bot
    const targetVersion = pickViewerVersion(bot.version, prismarineViewer.supportedVersions)
    this.bridge = createBlockStateBridge(bot.registry, targetVersion)

    if (this.bridge.translating) {
      this.logger.log(
        `Vision: rendering ${this.bridge.sourceVersion} world with the ${this.bridge.targetVersion} renderer `
        + `(${this.bridge.coverage.blocksMappedExactly} blocks mapped exactly, `
        + `${this.bridge.coverage.blocksWithChangedStates} collapsed to their default state, `
        + `${this.bridge.coverage.blocksWithoutTwin} without a counterpart)`,
      )
    }

    return this.bridge
  }

  private async start(): Promise<void> {
    this.feed = await startViewerFeed(this.mineflayer.bot, {
      port: config.vision.port,
      viewDistance: config.vision.viewDistance,
      bridge: await this.ensureBridge(),
    })

    const { browser, page } = await this.launchViewerPage(this.feed)
    this.browser = browser
    this.page = page
    this.feed.pushPosition()

    this.logger.log(`Vision: renderer ready on port ${this.feed.port}`)
  }

  private async startSelfie(): Promise<void> {
    this.selfieFeed = await startViewerFeed(this.mineflayer.bot, {
      port: config.vision.selfiePort,
      viewDistance: config.vision.viewDistance,
      // Third person: the page adds a visible bot model (with the default Steve texture) and keeps
      // the orbit camera, which the selfie pose then moves and retextures.
      firstPerson: false,
      bridge: await this.ensureBridge(),
    })

    const { browser, page } = await this.launchViewerPage(this.selfieFeed)
    this.selfieBrowser = browser
    this.selfiePage = page
    this.selfieFeed.pushPosition()

    this.logger.log(`Vision: selfie renderer ready on port ${this.selfieFeed.port}`)
  }

  /** Launches the headless page shared by both feeds, with the mesh probe and viewer hook installed. */
  private async launchViewerPage(feed: ViewerFeed): Promise<{ browser: Browser, page: Page }> {
    const browser = await chromium.launch({
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

    const page = await browser.newPage({
      viewport: { width: config.vision.width, height: config.vision.height },
    })

    page.on('pageerror', error => this.logger.warn(`Vision: renderer page error: ${errorMessageFrom(error)}`))

    await page.addInitScript(MESH_PROBE_SCRIPT)
    await page.addInitScript(VIEWER_HOOK_SCRIPT)
    await page.goto(`http://127.0.0.1:${feed.port}`, { waitUntil: 'load' })

    return { browser, page }
  }

  private async renderFrame(page: Page): Promise<{ image: Buffer, settled: boolean }> {
    const settled = await this.waitForSettle(page)
    return { image: await this.shoot(page), settled }
  }

  /**
   * Waits until the renderer has finished building the geometry it was asked for.
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
  private async waitForSettle(page: Page): Promise<boolean> {
    // A cold page has drawn nothing yet, so "no work outstanding" is not evidence of a finished
    // view until at least one section has actually been meshed.
    const requireMeshedWork = !this.warmedUp.get(page)
    const deadline = Date.now() + FRAME_SETTLE.timeoutMs

    while (Date.now() < deadline) {
      const stats = await readMeshProgress(page)

      const idle = stats !== null
        && stats.outstanding === 0
        && Date.now() - stats.lastActivityAt > FRAME_SETTLE.quietMs
      const hasDrawnSomething = stats !== null && stats.meshed > 0

      if (idle && (hasDrawnSomething || !requireMeshedWork)) {
        this.warmedUp.set(page, true)
        return true
      }

      await new Promise(resolve => setTimeout(resolve, FRAME_SETTLE.pollMs))
    }

    // Out of time. A partly meshed world still tells the model more than an error does, so the
    // frame is sent with `settled: false` and the tool says so in its result.
    this.logger.warn('Vision: the renderer did not finish meshing in time; sending a partial frame')
    return false
  }

  /**
   * Frames the shot inside the page, retrying while the bot model has not appeared yet.
   *
   * The model is created the moment the page sees its first position event and tweens to the bot
   * over the following frames, so a fresh page can legitimately report "not found" a few times; a
   * missed position event (the push racing the socket handshake) is fixed by pushing again.
   */
  private async poseSelfie(page: Page, feed: ViewerFeed, pose: SelfiePose): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      let outcome: { exposed: boolean, found: boolean }
      try {
        outcome = await page.evaluate<{ exposed: boolean, found: boolean }>(
          `(${SELFIE_POSE_SCRIPT})(${JSON.stringify(pose)})`,
        )
      }
      catch {
        // The page can be mid-navigation or closed underneath us; treat it as "not found yet".
        outcome = { exposed: true, found: false }
      }

      if (!outcome.exposed) {
        throw new Error(
          'The viewer page did not expose the renderer — the prismarine-viewer bundle likely changed and the viewer hook no longer matches it',
        )
      }

      if (outcome.found)
        return

      feed.pushPosition()
      await new Promise(resolve => setTimeout(resolve, 150))
    }

    this.logger.warn('Vision: no player model appeared in the selfie view; the frame shows the world without the bot')
  }

  /** Returns the camera to where the page had it before the selfie pose. */
  private async restoreSelfieCamera(page: Page): Promise<void> {
    try {
      await page.evaluate(`(() => {
        if (window.__airiSelfieRestore)
          window.__airiSelfieRestore()
        window.__airiSelfieRestore = null
      })()`)
    }
    catch {
      // The page can be mid-navigation or closing; the next selfie re-saves its own restore point.
    }
  }

  /**
   * Fetches the bot's skin at most once per camera session.
   *
   * Skins are account state that changes rarely mid-session; resolving repeatedly would hit the
   * Mojang servers on every selfie for nothing. Failures are remembered too, so an offline bot does
   * not retry (and log warnings) on every selfie — it keeps the default Steve texture.
   */
  private async resolveSkin(): Promise<string | null> {
    if (this.skinResolved)
      return this.skinDataUrl

    this.skinResolved = true
    try {
      this.skinDataUrl = await fetchBotSkinDataUrl(this.mineflayer.bot)
    }
    catch (error) {
      // The selfie must still work offline; the default skin is a perfectly fine fallback.
      this.logger.warn(`Vision: could not fetch the bot skin, keeping the default: ${errorMessageFrom(error)}`)
    }

    return this.skinDataUrl
  }

  private shoot(page: Page): Promise<Buffer> {
    return page.screenshot({ type: 'jpeg', quality: FRAME_SETTLE.jpegQuality })
  }

  /**
   * Mirrors the newest frame to disk so a human can see exactly what the bot saw.
   *
   * Deliberately a single overwritten file per view: this is a debugging window, not a history, and
   * an unbounded folder of frames would quietly fill the disk of a bot that likes to look around.
   */
  private async saveDebugFrame(image: Buffer, path = LATEST_FRAME_PATH): Promise<void> {
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, image)
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
