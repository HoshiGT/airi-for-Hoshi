import type { WidgetsIframeInitPayload } from '@proj-airi/plugin-sdk-tamagotchi/widgets'
import type { ShallowRef } from 'vue'

import type { MoveDecision, MoveResponse } from '../../shared/move-selection'
import type { EngineCandidate, Side, Variant } from '../../shared/types'

import { createContext } from '@moeru/eventa/adapters/window-message'
import {
  widgetsIframeBroadcastEvent,
  widgetsIframeChannel,
  widgetsIframeInitEvent,
  widgetsIframePublishEvent,
  widgetsIframeReadyEvent,
} from '@proj-airi/plugin-sdk-tamagotchi/widgets'
import { shallowRef } from 'vue'

import { buildMoveRequest, MOVE_NAMESPACE, MOVE_RESPONSE_NAME, resolveMove } from '../../shared/move-selection'

/** Inputs needed to ask Airi for a move during a `vs-airi` match. */
export interface AiriMoveRequest {
  variant: Variant
  airiSide: Side
  fen: string
  candidates: EngineCandidate[]
  fallbackResponseText: string
  timeoutMs?: number
}

/** Live bridge between the board iframe and the tamagotchi host. */
export interface AiriBridge {
  /** Latest host init snapshot (module config + runtime props). */
  init: ShallowRef<WidgetsIframeInitPayload | undefined>
  /** Asks Airi to choose among engine candidates; resolves to the move to play. */
  requestMove: (request: AiriMoveRequest) => Promise<MoveDecision>
  /** Tears down the transport. */
  dispose: () => void
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/**
 * Connects the board iframe to the host extension-ui bridge.
 *
 * Transport: the host owns a `window-message` Eventa context on the parent
 * window; the iframe mirrors it with `targetWindow`/`expectedSource` pointing at
 * `window.parent`. After subscribing, the iframe emits `ready`, prompting the
 * host to (re)send `init`.
 *
 * Move selection rides spark-notify: the iframe publishes a move request and the
 * host echoes Airi's reaction over `broadcast`. Responses are correlated by
 * `requestId` because several requests could be in flight across a session.
 */
export function createAiriBridge(): AiriBridge {
  const init = shallowRef<WidgetsIframeInitPayload | undefined>()

  const runtime = createContext({
    channel: widgetsIframeChannel,
    currentWindow: window,
    targetWindow: () => window.parent,
    expectedSource: () => window.parent,
  })

  // Pending move requests keyed by requestId, resolved when the matching
  // reaction broadcast arrives (or on timeout, by the requester).
  const pending = new Map<string, (response: MoveResponse) => void>()

  // Eventa delivers the emitted payload on the envelope's `body` field.
  runtime.context.on(widgetsIframeInitEvent, (event) => {
    init.value = event.body
  })

  runtime.context.on(widgetsIframeBroadcastEvent, (event) => {
    const envelope = readRecord(event.body)
    const route = readRecord(envelope?.route)
    if (route?.namespace !== MOVE_NAMESPACE || route?.name !== MOVE_RESPONSE_NAME) {
      return
    }
    const payload = readRecord(envelope?.payload)
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : undefined
    if (!requestId) {
      return
    }
    const resolve = pending.get(requestId)
    if (!resolve) {
      return
    }
    pending.delete(requestId)
    resolve({
      performance: readRecord(payload?.performance) as MoveResponse['performance'],
      text: typeof payload?.text === 'string' ? payload.text : undefined,
    })
  })

  // Announce readiness so the host sends the init snapshot.
  runtime.context.emit(widgetsIframeReadyEvent, undefined)

  async function requestMove(request: AiriMoveRequest): Promise<MoveDecision> {
    const requestId = crypto.randomUUID()
    const timeoutMs = request.timeoutMs ?? 8000

    const envelope = buildMoveRequest({
      variant: request.variant,
      airiSide: request.airiSide,
      fen: request.fen,
      candidates: request.candidates,
      requestId,
      fallbackResponseText: request.fallbackResponseText,
      timeoutMs,
    })

    const response = await new Promise<MoveResponse>((resolve) => {
      pending.set(requestId, resolve)
      // Resolve empty on timeout so the caller falls back to the engine best.
      setTimeout(() => {
        if (pending.delete(requestId)) {
          resolve({})
        }
      }, timeoutMs + 2000)

      // NOTICE:
      // Emit the envelope as the event payload; the host receives it as `event.body`.
      // The widgets transport fixes its payload to `Record<string, unknown>` (the
      // host contract), so the strongly-typed, structured-clone-safe envelope is
      // widened at this boundary. Removable if `defineEventa` gains a generic emit.
      runtime.context.emit(widgetsIframePublishEvent, envelope as unknown as Record<string, unknown>)
    })

    return resolveMove(response, request.candidates, request.fallbackResponseText)
  }

  return {
    init,
    requestMove,
    dispose: () => runtime.dispose(),
  }
}
