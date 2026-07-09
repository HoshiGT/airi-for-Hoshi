import type { GameEngineAnalyzeResultEvent, WebSocketBaseEvent, WebSocketEventOptionalSource, WebSocketEvents } from '@proj-airi/server-sdk'

import type { EngineAdapter } from './engine'
import type { Variant } from './shared'

import { nanoid } from 'nanoid'

import { useModsServerChannelStore } from '../../../stores/mods/api/channel-server'
import { createEngine } from './engine'

/**
 * Server-side engine adapter: full-strength native UCI engines (Stockfish /
 * Pikafish) running in the `@proj-airi/game-engine` service, reached over the
 * existing AIRI server channel.
 *
 * Request/response envelope: a `game:engine:analyze` request routes to the one
 * registered engine-service consumer; the reply broadcasts back as
 * `game:engine:analyze:result` and is matched here by `requestId`. Requests are
 * also stamped with `metadata.event.id = requestId` and sent with
 * `delivery.required`, so a runtime with NO engine service answers immediately
 * with an `error` event whose `parentId` is that id — failing fast instead of
 * waiting out the response timeout.
 */

/** The slice of the server channel the engine adapter needs; injected in tests. */
export interface EngineChannel {
  /** Snapshot of the websocket link state. */
  isConnected: () => boolean
  /** Kicks connection setup off; completion is observed via {@link isConnected}. */
  ensureConnected: () => void
  send: (event: WebSocketEventOptionalSource) => void
  /** Subscribes to one event type; returns the unsubscribe function. */
  onEvent: <E extends keyof WebSocketEvents>(
    type: E,
    callback: (event: WebSocketBaseEvent<E, WebSocketEvents[E]>) => void | Promise<void>,
  ) => () => void
}

/** Production channel: the app's shared server connection (Pinia store). */
function channelFromStore(): EngineChannel {
  const store = useModsServerChannelStore()
  return {
    isConnected: () => store.connected,
    // ensureConnected's promise never settles when no server is reachable, so
    // availability is polled via isConnected instead of awaited.
    ensureConnected: () => void store.ensureConnected(),
    send: event => store.send(event),
    onEvent: (type, callback) => store.onEvent(type, callback),
  }
}

// How long to wait for the websocket to come up before deciding the server is
// absent. The channel queues sends while connecting, so a link that comes up
// just under the limit still delivers the probe.
const CONNECT_WAIT_MS = 1500
// The probe is a real (tiny) search so it doubles as an engine warm-up; its
// generous timeout covers Pikafish loading its ~50MB NNUE net on first spawn.
const PROBE_MOVETIME_MS = 80
const PROBE_TIMEOUT_MS = 10_000
// Per-move search budget. Native engines are already very strong at this
// budget; playing strength toward the player is shaped by the adaptive move
// policy (selectMove), not by searching longer.
const ANALYZE_MOVETIME_MS = 600
// Same candidate spread the local engine produces, for the easing policy.
const ANALYZE_MULTI_PV = 5
// Response wind-down headroom, mirroring the service's own bestmove guard.
const RESPONSE_HEADROOM_MS = 4000

// Standard opening positions, used only for the availability probe.
const START_FEN: Record<Variant, string> = {
  chess: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  xiangqi: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
}

interface PendingRequest {
  resolve: (result: GameEngineAnalyzeResultEvent) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * One shared result/error subscription with per-request correlation, so an
 * adapter registers two channel listeners for its whole life instead of a pair
 * per move. Results for requestIds we did not issue (another board, another
 * tab) are ignored.
 */
function createRequester(channel: EngineChannel) {
  const pending = new Map<string, PendingRequest>()

  function settle(requestId: string): PendingRequest | undefined {
    const entry = pending.get(requestId)
    if (entry) {
      pending.delete(requestId)
      clearTimeout(entry.timer)
    }
    return entry
  }

  const offResult = channel.onEvent('game:engine:analyze:result', (event) => {
    settle(event.data.requestId)?.resolve(event.data)
  })
  const offError = channel.onEvent('error', (event) => {
    // The runtime replies `error` with parentId = the request's event id when
    // required delivery finds no consumer (engine service offline); other
    // peers' errors carry foreign parentIds and fall through the map lookup.
    const parentId = event.metadata?.event?.parentId
    if (!parentId) {
      return
    }
    const message = (event.data as { message?: string })?.message ?? 'engine request rejected'
    settle(parentId)?.reject(new Error(message))
  })

  return {
    request(variant: Variant, fen: string, search: { multiPv: number, movetimeMs: number }, timeoutMs: number): Promise<GameEngineAnalyzeResultEvent> {
      const requestId = nanoid()
      return new Promise<GameEngineAnalyzeResultEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error('engine service did not answer in time'))
        }, timeoutMs)
        pending.set(requestId, { resolve, reject, timer })
        channel.send({
          type: 'game:engine:analyze',
          data: { requestId, variant, fen, multiPv: search.multiPv, movetimeMs: search.movetimeMs },
          metadata: { event: { id: requestId } },
          route: { delivery: { required: true } },
        })
      })
    },
    /** Unsubscribes and rejects everything in flight. */
    dispose() {
      offResult()
      offError()
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error('server engine disposed'))
      }
      pending.clear()
    },
  }
}

/** Polls `condition` until it holds or `timeoutMs` passes. */
function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (condition()) {
      resolve(true)
      return
    }
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer)
        resolve(true)
      }
      else if (Date.now() >= deadline) {
        clearInterval(timer)
        resolve(false)
      }
    }, 50)
  })
}

/**
 * Connects to the server-side engine for `variant`, or `undefined` when it is
 * unreachable (no websocket, no engine service, or the service reports the
 * variant's engine missing) — the caller then uses the built-in engine.
 */
export async function createServerEngine(variant: Variant, channel: EngineChannel): Promise<EngineAdapter | undefined> {
  channel.ensureConnected()
  if (!await waitFor(() => channel.isConnected(), CONNECT_WAIT_MS)) {
    return undefined
  }

  const requester = createRequester(channel)
  try {
    const probe = await requester.request(variant, START_FEN[variant], { multiPv: 1, movetimeMs: PROBE_MOVETIME_MS }, PROBE_TIMEOUT_MS)
    if (probe.error) {
      requester.dispose()
      return undefined
    }
  }
  catch {
    requester.dispose()
    return undefined
  }

  return {
    async analyze(fen) {
      const result = await requester.request(
        variant,
        fen,
        { multiPv: ANALYZE_MULTI_PV, movetimeMs: ANALYZE_MOVETIME_MS },
        ANALYZE_MOVETIME_MS + RESPONSE_HEADROOM_MS,
      )
      if (result.error) {
        throw new Error(result.error)
      }
      return { best: result.best, candidates: result.candidates }
    },
    dispose: () => requester.dispose(),
  }
}

/** An engine plus where it currently runs; `source` flips once on degradation. */
export interface GameEngine extends EngineAdapter {
  source: 'server' | 'local'
}

/**
 * The engine the game should actually play against: the server-side native
 * engine when reachable, the built-in alpha-beta search otherwise. If the
 * server stops answering mid-game, the adapter degrades to the built-in engine
 * permanently for this session instead of erroring the move.
 */
export async function createGameEngine(
  variant: Variant,
  options: {
    /** @default the app's shared server channel */
    channel?: EngineChannel
    /** Built-in engine factory; injected in tests. @default createEngine */
    createLocalEngine?: (variant: Variant) => Promise<EngineAdapter>
  } = {},
): Promise<GameEngine> {
  const createLocal = options.createLocalEngine ?? createEngine
  const server = await createServerEngine(variant, options.channel ?? channelFromStore())

  // No server: create the built-in engine NOW so a load failure (ffish wasm)
  // surfaces at game start, where the caller already reports engine errors.
  if (!server) {
    const localEngine = await createLocal(variant)
    return {
      source: 'local',
      analyze: fen => localEngine.analyze(fen),
      dispose: () => localEngine.dispose(),
    }
  }

  let local: Promise<EngineAdapter> | undefined
  const engine: GameEngine = {
    source: 'server',
    async analyze(fen) {
      if (engine.source === 'server') {
        try {
          return await server.analyze(fen)
        }
        catch {
          // Service died mid-game: finish the game on the built-in engine
          // rather than surfacing an error for a move the local search can play.
          engine.source = 'local'
          server.dispose()
        }
      }
      local ??= createLocal(variant)
      return (await local).analyze(fen)
    },
    dispose() {
      server.dispose()
      void local?.then(instance => instance.dispose())
    },
  }
  return engine
}
