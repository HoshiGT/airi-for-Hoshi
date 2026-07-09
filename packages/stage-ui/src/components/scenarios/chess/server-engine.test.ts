import type { GameEngineAnalyzeResultEvent } from '@proj-airi/server-sdk'

import type { EngineAdapter } from './engine'
import type { EngineChannel } from './server-engine'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createGameEngine, createServerEngine } from './server-engine'

interface SentAnalyze {
  type: string
  data: { requestId: string, variant: string, fen: string, multiPv: number, movetimeMs?: number }
  metadata?: { event?: { id?: string } }
  route?: { delivery?: { required?: boolean } }
}

/**
 * In-memory {@link EngineChannel}: tests script the service side by replying
 * to captured sends. Replies go through a microtask like a real socket would
 * (never synchronously inside `send`).
 */
function fakeChannel(options: { connected?: boolean, onAnalyze?: (request: SentAnalyze, reply: (data: GameEngineAnalyzeResultEvent) => void, fail: (message: string) => void) => void } = {}) {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const sent: SentAnalyze[] = []
  let connected = options.connected ?? true

  function emit(type: string, event: unknown) {
    queueMicrotask(() => {
      for (const listener of listeners.get(type) ?? []) {
        listener(event)
      }
    })
  }

  const channel: EngineChannel = {
    isConnected: () => connected,
    ensureConnected: () => {},
    send: (event) => {
      const request = event as unknown as SentAnalyze
      sent.push(request)
      options.onAnalyze?.(
        request,
        data => emit('game:engine:analyze:result', { type: 'game:engine:analyze:result', data, metadata: { event: { id: 'reply' } } }),
        message => emit('error', { type: 'error', data: { message }, metadata: { event: { id: 'reply', parentId: request.data.requestId } } }),
      )
    },
    onEvent: (type, callback) => {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(callback as (event: unknown) => void)
      return () => set.delete(callback as (event: unknown) => void)
    },
  }

  const setConnected = (value: boolean) => {
    connected = value
  }
  return { channel, sent, emit, setConnected }
}

function okReply(request: SentAnalyze, extra?: Partial<GameEngineAnalyzeResultEvent>): GameEngineAnalyzeResultEvent {
  return {
    requestId: request.data.requestId,
    variant: request.data.variant as GameEngineAnalyzeResultEvent['variant'],
    best: 'e2e4',
    candidates: [
      { uci: 'e2e4', rank: 1, scoreCp: 30 },
      { uci: 'd2d4', rank: 2, scoreCp: 12 },
    ],
    ...extra,
  }
}

describe('createServerEngine', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('probes the service and analyzes over the channel', async () => {
    const { channel, sent } = fakeChannel({
      onAnalyze: (request, reply) => reply(okReply(request)),
    })

    const engine = await createServerEngine('chess', channel)
    expect(engine).toBeDefined()

    const analysis = await engine!.analyze('some-fen')
    expect(analysis.best).toBe('e2e4')
    expect(analysis.candidates).toHaveLength(2)
    expect(analysis.candidates[0].rank).toBe(1)

    // Probe first, then the real analyze; both stamped for error correlation
    // and sent with required delivery so a missing service errors back fast.
    expect(sent).toHaveLength(2)
    expect(sent[0].data.multiPv).toBe(1)
    expect(sent[1].data.fen).toBe('some-fen')
    expect(sent[1].data.multiPv).toBe(5)
    expect(sent[1].metadata?.event?.id).toBe(sent[1].data.requestId)
    expect(sent[1].route?.delivery?.required).toBe(true)

    engine!.dispose()
  })

  it('returns undefined when the websocket never connects', async () => {
    vi.useFakeTimers()
    const { channel, sent } = fakeChannel({ connected: false })

    const creating = createServerEngine('chess', channel)
    await vi.advanceTimersByTimeAsync(1600)

    expect(await creating).toBeUndefined()
    // Never probed: there is nothing to send to.
    expect(sent).toHaveLength(0)
  })

  it('returns undefined when the runtime reports no engine service', async () => {
    const { channel } = fakeChannel({
      onAnalyze: (request, _reply, fail) => fail('no consumer registered for requested event delivery'),
    })

    expect(await createServerEngine('chess', channel)).toBeUndefined()
  })

  it('returns undefined when the service reports the variant engine missing', async () => {
    const { channel } = fakeChannel({
      onAnalyze: (request, reply) => reply(okReply(request, { best: '', candidates: [], error: 'no engine configured for variant "xiangqi"' })),
    })

    expect(await createServerEngine('xiangqi', channel)).toBeUndefined()
  })

  it('returns undefined when the probe times out', async () => {
    vi.useFakeTimers()
    const { channel } = fakeChannel({ onAnalyze: () => {} })

    const creating = createServerEngine('chess', channel)
    await vi.advanceTimersByTimeAsync(10_100)

    expect(await creating).toBeUndefined()
  })

  it('ignores results for requestIds it did not issue', async () => {
    vi.useFakeTimers()
    const { channel, emit } = fakeChannel({
      onAnalyze: (request, reply) => {
        // A foreign board's result arrives first; it must not satisfy our probe.
        emit('game:engine:analyze:result', {
          type: 'game:engine:analyze:result',
          data: okReply({ ...request, data: { ...request.data, requestId: 'someone-else' } }, { best: 'a2a3' }),
          metadata: { event: { id: 'foreign' } },
        })
        reply(okReply(request))
      },
    })

    const engine = await createServerEngine('chess', channel)
    expect(engine).toBeDefined()
    engine!.dispose()
  })
})

describe('createGameEngine', () => {
  it('uses the built-in engine when no server is reachable', async () => {
    vi.useFakeTimers()
    const { channel } = fakeChannel({ connected: false })
    const local: EngineAdapter = {
      analyze: async () => ({ best: 'g1f3', candidates: [{ uci: 'g1f3', rank: 1, scoreCp: 5 }] }),
      dispose: vi.fn(),
    }

    const creating = createGameEngine('chess', { channel, createLocalEngine: async () => local })
    await vi.advanceTimersByTimeAsync(1600)
    const engine = await creating
    vi.useRealTimers()

    expect(engine.source).toBe('local')
    const analysis = await engine.analyze('fen')
    expect(analysis.best).toBe('g1f3')
  })

  it('degrades from server to the built-in engine when the service dies mid-game', async () => {
    let calls = 0
    const { channel } = fakeChannel({
      onAnalyze: (request, reply, fail) => {
        calls += 1
        // Probe and first move answer; afterwards the service is gone.
        if (calls <= 2) {
          reply(okReply(request))
        }
        else {
          fail('no consumer registered for requested event delivery')
        }
      },
    })
    const local: EngineAdapter = {
      analyze: async () => ({ best: 'g1f3', candidates: [{ uci: 'g1f3', rank: 1, scoreCp: 5 }] }),
      dispose: vi.fn(),
    }

    const engine = await createGameEngine('chess', { channel, createLocalEngine: async () => local })
    expect(engine.source).toBe('server')

    const first = await engine.analyze('fen-1')
    expect(first.best).toBe('e2e4')
    expect(engine.source).toBe('server')

    // Service offline: the move still resolves, now from the local engine.
    const second = await engine.analyze('fen-2')
    expect(second.best).toBe('g1f3')
    expect(engine.source).toBe('local')

    engine.dispose()
    // Local disposal rides the already-resolved engine promise (one microtask).
    await Promise.resolve()
    expect(local.dispose).toHaveBeenCalled()
  })
})
