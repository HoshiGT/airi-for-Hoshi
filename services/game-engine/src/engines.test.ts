import process from 'node:process'

import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { createEnginePool } from './engines'

// Real child-process coverage: the pool drives test/fake-uci-engine.mjs via
// node, exercising spawn, stdio line buffering, handshake, queueing, crash
// recovery and launch failure without mocking Node built-ins.
const FAKE_ENGINE = fileURLToPath(new URL('../test/fake-uci-engine.mjs', import.meta.url))
const NODE_BIN = process.execPath

function fakeEnginePool() {
  return createEnginePool({
    chess: { binary: NODE_BIN, args: [FAKE_ENGINE] },
  })
}

describe('createEnginePool', () => {
  let pool: ReturnType<typeof createEnginePool> | undefined

  afterEach(() => {
    pool?.dispose()
    pool = undefined
  })

  it('spawns, handshakes and returns ranked MultiPV candidates', async () => {
    pool = fakeEnginePool()

    const analysis = await pool.analyze('chess', 'startpos-fen', { multiPv: 2, movetimeMs: 20 })

    expect(analysis.best).toBe('e2e4')
    expect(analysis.candidates).toHaveLength(2)
    expect(analysis.candidates[0].uci).toBe('e2e4')
    expect(analysis.candidates[0].rank).toBe(1)
    expect(analysis.candidates[1].uci).toBe('d2d4')
    expect(analysis.candidates[1].mate).toBe(3)
  })

  it('serializes concurrent requests onto one engine', async () => {
    pool = fakeEnginePool()

    // The fake engine answers an overlapping `go` with `bestmove XXXX`, so
    // clean results here prove the queue never interleaved the searches.
    const [first, second] = await Promise.all([
      pool.analyze('chess', 'fen-one', { multiPv: 1, movetimeMs: 40 }),
      pool.analyze('chess', 'fen-two', { multiPv: 1, movetimeMs: 40 }),
    ])

    expect(first.best).toBe('e2e4')
    expect(second.best).toBe('e2e4')
  })

  // ROOT CAUSE:
  //
  // A request issued right after the engine process died could still grab the
  // cached (dying) engine — the 'exit' event that evicts it runs a tick later.
  // The request then wrote into a dead pipe, produced no output, and only
  // resolved via the UCI safety timer ~4s later with an EMPTY best move.
  //
  // Fixed by racing every analyze against a per-engine death promise (fail
  // fast instead of timing out empty) and retrying the request once on a
  // fresh spawn.
  it('respawns the engine after a crash', async () => {
    pool = fakeEnginePool()

    // CRASH makes the fake engine exit right after replying.
    const beforeCrash = await pool.analyze('chess', 'CRASH', { multiPv: 1, movetimeMs: 20 })
    expect(beforeCrash.best).toBe('e2e4')

    const afterCrash = await pool.analyze('chess', 'healthy-fen', { multiPv: 1, movetimeMs: 20 })
    expect(afterCrash.best).toBe('e2e4')
  })

  it('rejects for a variant with no configured engine', async () => {
    pool = fakeEnginePool()

    await expect(pool.analyze('xiangqi', 'fen', { multiPv: 1, movetimeMs: 20 }))
      .rejects
      .toThrow('no engine configured for variant "xiangqi"')
  })

  it('rejects when the binary does not exist, then retries cleanly', async () => {
    pool = createEnginePool({
      chess: { binary: '/nonexistent/engine-binary' },
    })

    await expect(pool.analyze('chess', 'fen', { multiPv: 1, movetimeMs: 20 }))
      .rejects
      .toThrow()
    // The failed start must not stay cached as a broken engine.
    await expect(pool.analyze('chess', 'fen', { multiPv: 1, movetimeMs: 20 }))
      .rejects
      .toThrow()
  })
})

// Integration proof against the real Pikafish binary; set PIKAFISH_BIN (and
// PIKAFISH_NNUE if the net is not next to the binary) to enable.
describe.runIf(process.env.PIKAFISH_BIN)('pikafish integration', () => {
  it('analyzes the xiangqi opening position', async () => {
    const pool = createEnginePool({
      xiangqi: {
        binary: process.env.PIKAFISH_BIN!,
        options: {
          Threads: 1,
          ...(process.env.PIKAFISH_NNUE ? { EvalFile: process.env.PIKAFISH_NNUE } : {}),
        },
      },
    })

    try {
      const analysis = await pool.analyze(
        'xiangqi',
        'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
        { multiPv: 3, movetimeMs: 300 },
      )

      expect(analysis.best).toMatch(/^[a-i]\d+[a-i]\d+$/)
      expect(analysis.candidates.length).toBeGreaterThan(0)
      expect(analysis.candidates[0].rank).toBe(1)
    }
    finally {
      pool.dispose()
    }
  }, 30_000)
})
