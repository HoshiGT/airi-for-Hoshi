import type { GameEngineVariant } from '@proj-airi/plugin-protocol/types'

import type { EngineConfig } from './engines'

import process, { env } from 'node:process'

import { Format, LogLevel, setGlobalFormat, setGlobalLogLevel, useLogg } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std'
import { Client } from '@proj-airi/server-sdk'

import { createEnginePool } from './engines'

setGlobalFormat(Format.Pretty)
setGlobalLogLevel(LogLevel.Log)
const log = useLogg('GameEngine').useGlobalConfig()

// Guard rails for request payloads: an over-large MultiPV or movetime must not
// let one board request pin an engine (and every queued request behind it).
const MULTI_PV_MAX = 8
const MOVETIME_MS_MIN = 50
const MOVETIME_MS_MAX = 10_000
const MOVETIME_MS_DEFAULT = 800

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Builds the per-variant engine configs from the environment. A variant with
 * no usable binary is simply absent — the pool then answers its requests with
 * an error and the board falls back to its built-in engine.
 *
 * Env:
 * - `STOCKFISH_BIN` — chess binary; defaults to `stockfish` from PATH.
 * - `PIKAFISH_BIN` — xiangqi binary; xiangqi is DISABLED when unset (there is
 *   no conventional PATH name to probe for).
 * - `PIKAFISH_NNUE` — network file passed as `EvalFile`; when unset Pikafish
 *   looks for `pikafish.nnue` next to the binary (the pool sets cwd there).
 * - `ENGINE_THREADS` — search threads per engine (default 1).
 */
function engineConfigsFromEnv(): Partial<Record<GameEngineVariant, EngineConfig>> {
  const threads = clamp(Number(env.ENGINE_THREADS || '1') || 1, 1, 8)
  const configs: Partial<Record<GameEngineVariant, EngineConfig>> = {}

  configs.chess = {
    binary: env.STOCKFISH_BIN || 'stockfish',
    options: { Threads: threads },
  }

  if (env.PIKAFISH_BIN) {
    configs.xiangqi = {
      binary: env.PIKAFISH_BIN,
      options: {
        Threads: threads,
        ...(env.PIKAFISH_NNUE ? { EvalFile: env.PIKAFISH_NNUE } : {}),
      },
    }
  }

  return configs
}

/**
 * AIRI game-engine service: native UCI engines behind the server channel.
 *
 * Registers as the `game-engine` consumer group so `game:engine:analyze`
 * requests route here; each reply broadcasts back as
 * `game:engine:analyze:result` correlated by `requestId`.
 *
 * Call stack:
 *
 * main (this file)
 *   -> {@link engineConfigsFromEnv}
 *   -> {@link createEnginePool}
 *     -> spawnUciTransport (./engines)
 *       -> uciHandshake / analyzeViaUci (./uci)
 *   -> Client('game:engine:analyze' handler)
 *     -> pool.analyze -> send 'game:engine:analyze:result'
 */
async function main() {
  const configs = engineConfigsFromEnv()
  log.withFields({
    chess: configs.chess?.binary ?? 'disabled',
    xiangqi: configs.xiangqi?.binary ?? 'disabled (set PIKAFISH_BIN)',
  }).log('Engine configuration')

  const pool = createEnginePool(configs)

  const client = new Client({
    name: 'proj-airi:game-engine',
    possibleEvents: ['game:engine:analyze', 'game:engine:analyze:result'],
    url: env.AIRI_URL || 'ws://localhost:6121/ws',
    token: env.AIRI_TOKEN || undefined,
    // onReady fires on every successful (re)connect; consumer registrations
    // live on the server side of the connection, so re-register each time.
    onReady: () => {
      client.send({
        type: 'module:consumer:register',
        data: { event: 'game:engine:analyze', mode: 'consumer-group', group: 'game-engine' },
      })
      log.log('Connected; registered as game-engine consumer')
    },
  })

  client.onEvent('game:engine:analyze', async (event) => {
    const { requestId, variant, fen, multiPv, movetimeMs } = event.data
    try {
      const analysis = await pool.analyze(variant, fen, {
        multiPv: clamp(Math.trunc(multiPv) || 1, 1, MULTI_PV_MAX),
        movetimeMs: clamp(Math.trunc(movetimeMs ?? MOVETIME_MS_DEFAULT) || MOVETIME_MS_DEFAULT, MOVETIME_MS_MIN, MOVETIME_MS_MAX),
      })
      client.send({
        type: 'game:engine:analyze:result',
        data: { requestId, variant, best: analysis.best, candidates: analysis.candidates },
      })
    }
    catch (error) {
      log.withError(error).warn('Analyze failed')
      client.send({
        type: 'game:engine:analyze:result',
        data: { requestId, variant, best: '', candidates: [], error: errorMessageFrom(error) ?? 'analyze failed' },
      })
    }
  })

  async function gracefulShutdown(signal: string) {
    log.log(`Received ${signal}, shutting down...`)
    pool.dispose()
    client.close()
    process.exit(0)
  }

  process.on('SIGINT', () => void gracefulShutdown('SIGINT'))
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'))
}

main().catch(err => log.withError(err).error('An error occurred'))
