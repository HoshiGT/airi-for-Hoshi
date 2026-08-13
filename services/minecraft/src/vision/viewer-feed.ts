import type { Server } from 'node:net'

import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'

import type { BlockStateBridge } from './block-state-bridge'

import { createServer } from 'node:net'

import { mineflayer as startPrismarineViewer } from 'prismarine-viewer'

/** A running viewer web server that a headless browser can point at. */
export interface ViewerFeed {
  readonly port: number
  /**
   * Pushes the bot's current position and head rotation to connected viewers.
   *
   * The upstream server only sends camera updates when mineflayer emits `move`, so a bot that is
   * standing still never tells a freshly connected page where to look — it would keep the default
   * orbit camera. Call this right before capturing to guarantee the frame matches where the bot is
   * actually looking at that moment.
   */
  pushPosition: () => void
  close: () => void
}

export interface ViewerFeedOptions {
  port: number
  /** Chunk radius streamed to the viewer. Larger costs meshing time on every new chunk. */
  viewDistance: number
  /** True renders through the bot's eyes; false renders an orbit camera with a visible bot model. */
  firstPerson?: boolean
  bridge: BlockStateBridge
}

/**
 * Exposes the page's `Viewer` internals on `window.__airiViewer` by intercepting the moment the
 * bundle publishes three.js to the global scope.
 *
 * NOTICE:
 * The viewer instance is constructed inside the webpack bundle's module scope and never published
 * (`prismarine-viewer/lib/index.js`), so `page.evaluate()` has no way to reach `viewer.scene` or
 * `viewer.camera` afterwards. The bundle does, however, run `globalThis.THREE = require('three')`
 * before constructing anything — a plain global assignment that an init script can intercept.
 *
 * But three's own exports are getter-only module properties (webpack's ES module output), so
 * wrapping `THREE.Scene` / `THREE.PerspectiveCamera` is impossible: assigning to them silently
 * does nothing. The one hookable seam is `THREE.OrbitControls`, which the examples module attaches
 * to the namespace with a plain assignment. Intercepting that yields the viewer's camera straight
 * from the constructor's first argument, and the camera's prototype chain gives `Object3D.prototype`,
 * whose `add` can be wrapped to observe the scene: every mesh the page adds — lights, chunk
 * sections, the bot model — is added to `viewer.scene`, and `this` of the call is the scene itself.
 *
 * Must run as an init script: all of this happens during the bundle's synchronous startup.
 *
 * Removal condition: never, unless prismarine-viewer starts publishing the viewer instance itself.
 */
export const VIEWER_HOOK_SCRIPT = `(() => {
  const exposed = { THREE: null, scene: null, camera: null, controls: null }
  window.__airiViewer = exposed

  const hookedProtos = new WeakSet()

  // Runs while the OrbitControls constructor is on the stack, i.e. during bundle startup, before
  // any chunk section or the bot model has been added to the scene.
  const hookSceneCapture = (camera) => {
    if (!camera)
      return

    // Walk up to the prototype that *owns* 'add' (Object3D.prototype), not just the first one that
    // inherits it: patching an intermediate prototype would shadow nothing but itself, and
    // scene.add would never pass through the wrapper.
    let proto = camera
    while (proto) {
      proto = Object.getPrototypeOf(proto)
      if (proto && Object.prototype.hasOwnProperty.call(proto, 'add'))
        break
    }

    if (!proto || hookedProtos.has(proto))
      return

    hookedProtos.add(proto)
    const originalAdd = proto.add
    proto.add = function (...args) {
      if (!exposed.scene && this.isScene === true)
        exposed.scene = this
      return originalAdd.apply(this, args)
    }
  }

  let hooked = false
  const hook = (THREE) => {
    if (hooked)
      return
    hooked = true
    exposed.THREE = THREE

    // OrbitControls attaches itself to the namespace after three has already loaded, so it is
    // wrapped on assignment instead of up front.
    let OrbitControls = null
    Object.defineProperty(THREE, 'OrbitControls', {
      configurable: true,
      get: () => OrbitControls,
      set: (Original) => {
        OrbitControls = class extends Original {
          constructor(...args) {
            super(...args)
            if (!exposed.controls)
              exposed.controls = this
            if (!exposed.camera && args[0] && args[0].isPerspectiveCamera === true)
              exposed.camera = args[0]
            hookSceneCapture(args[0])
          }
        }
      },
    })
  }

  Object.defineProperty(window, 'THREE', {
    configurable: true,
    get: () => exposed.THREE,
    set: hook,
  })
})()`

/**
 * Starts the prismarine-viewer web server against a translated view of the bot.
 *
 * The bot is not handed to the viewer directly. It goes through a proxy that reports the version
 * the viewer can render and rewrites every block state id on its way out (see
 * {@link BlockStateBridge}). Everything else — the socket.io protocol, chunk streaming, entity
 * tracking — stays owned by the upstream package.
 */
export async function startViewerFeed(bot: Bot, options: ViewerFeedOptions): Promise<ViewerFeed> {
  await assertPortFree(options.port)

  const { view, pushPosition } = createTranslatedBotView(bot, options.bridge)

  startPrismarineViewer(view, {
    port: options.port,
    viewDistance: options.viewDistance,
    firstPerson: options.firstPerson ?? true,
  })

  return {
    port: options.port,
    pushPosition,
    close: () => viewerHandleOf(bot)?.close?.(),
  }
}

/**
 * Fails fast with a readable message instead of letting express emit an unhandled `error` event,
 * which would take the whole bot process down long after this call has returned.
 */
async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe: Server = createServer()
    probe.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error(`Vision viewer port ${port} is already in use (set BOT_VISION_PORT to a free port)`)
        : error)
    })
    probe.once('listening', () => probe.close(() => resolve()))
    probe.listen(port, '127.0.0.1')
  })
}

/** `bot.viewer` is installed by prismarine-viewer and is not part of mineflayer's own type. */
function viewerHandleOf(bot: Bot): { close?: () => void } | undefined {
  return (bot as Bot & { viewer?: { close?: () => void } }).viewer
}

interface TranslatedBotView {
  view: Bot
  pushPosition: () => void
}

/**
 * Wraps the bot so the viewer sees a world it can render.
 *
 * Three things are intercepted; everything else passes straight through to the real bot:
 *
 * - `version`  — the viewer refuses versions it has no models for, so it is told the target version.
 * - `world`    — chunk columns are re-serialized with translated state ids.
 * - `on`/`removeListener` — `blockUpdate` carries a raw state id for live block changes, and the
 *   `move` listener is kept so {@link ViewerFeed.pushPosition} can drive the camera on demand.
 */
function createTranslatedBotView(bot: Bot, bridge: BlockStateBridge): TranslatedBotView {
  const moveListeners = new Set<(...args: unknown[]) => void>()

  // Listeners must be removable: the viewer unregisters its handlers on socket disconnect, and it
  // can only pass back the function it originally handed us.
  const wrappersByListener = new WeakMap<(...args: unknown[]) => void, (...args: unknown[]) => void>()

  const world = {
    getColumnAt: async (position: unknown) => {
      const column = await bot.world.getColumnAt(position as never)
      if (!column)
        return column

      return { toJson: () => bridge.remapChunkJson(column.toJson()) }
    },
  }

  function listenerFor(event: string, listener: (...args: unknown[]) => void): (...args: unknown[]) => void {
    if (event === 'move')
      moveListeners.add(listener)

    if (event !== 'blockUpdate')
      return listener

    const existing = wrappersByListener.get(listener)
    if (existing)
      return existing

    const wrapper = (...args: unknown[]): void => {
      const [oldBlock, newBlock] = args as [Block | null, Block | null]
      listener(oldBlock, newBlock ? translatedBlock(newBlock, bridge) : newBlock)
    }
    wrappersByListener.set(listener, wrapper)
    return wrapper
  }

  const view = new Proxy(bot, {
    get(target, property, receiver) {
      if (property === 'version')
        return bridge.targetVersion
      if (property === 'world')
        return world

      if (property === 'on' || property === 'addListener' || property === 'once') {
        return (event: string, listener: (...args: unknown[]) => void) => {
          const method = property as 'on' | 'addListener' | 'once'
          ;(target[method] as (e: string, l: (...args: unknown[]) => void) => unknown)(event, listenerFor(event, listener))
          return receiver
        }
      }

      if (property === 'removeListener' || property === 'off') {
        return (event: string, listener: (...args: unknown[]) => void) => {
          moveListeners.delete(listener)
          const method = property as 'removeListener' | 'off'
          ;(target[method] as (e: string, l: (...args: unknown[]) => void) => unknown)(
            event,
            event === 'blockUpdate' ? (wrappersByListener.get(listener) ?? listener) : listener,
          )
          return receiver
        }
      }

      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return {
    view,
    pushPosition: () => {
      for (const listener of moveListeners)
        listener(bot.entity?.position)
    },
  }
}

/**
 * Presents a block with a translated `stateId` while leaving the original object intact.
 *
 * Prototype delegation is deliberate: the viewer reads `stateId` here, but a `Block` also carries
 * getters and methods that a spread copy would drop.
 */
function translatedBlock(block: Block, bridge: BlockStateBridge): Block {
  return Object.create(block, {
    stateId: { value: bridge.remapStateId(block.stateId ?? 0), enumerable: true },
  }) as Block
}
