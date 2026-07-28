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
  bridge: BlockStateBridge
}

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
    firstPerson: true,
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
