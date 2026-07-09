import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { GameEngineVariant } from '@proj-airi/plugin-protocol/types'

import type { AnalyzeOptions, RawAnalysis, UciTransport } from './uci'

import { spawn } from 'node:child_process'
import { dirname } from 'node:path'

import { analyzeViaUci, uciHandshake } from './uci'

/** How to launch and configure one native UCI engine. */
export interface EngineConfig {
  /** Path to the engine binary, or a bare command resolved from PATH. */
  binary: string
  /** Extra argv passed to the binary. @default [] */
  args?: string[]
  /**
   * `setoption` values applied after `uciok` (e.g. Pikafish's `EvalFile`,
   * `Threads`). Applied before `isready`, as UCI requires.
   */
  options?: Record<string, string | number>
}

/**
 * Serialized access to a running set of UCI engines, one per variant.
 *
 * State model: each variant holds at most one child process, spawned lazily on
 * its first analyze and reused afterwards. UCI is single-search — an engine
 * only runs one `go` at a time — so requests per variant queue behind a promise
 * chain. A process that dies (crash, kill) rejects its in-flight request and is
 * cleared; the next request respawns it.
 */
export function createEnginePool(configs: Partial<Record<GameEngineVariant, EngineConfig>>) {
  interface RunningEngine {
    transport: UciTransport
    /** Tail of the per-engine request queue; new analyzes chain onto it. */
    queue: Promise<unknown>
    /**
     * Rejects when the child process exits. Raced against every analyze so a
     * request on a dying engine fails immediately instead of sitting out the
     * UCI safety timer and returning an empty result.
     */
    death: Promise<never>
  }

  const running = new Map<GameEngineVariant, Promise<RunningEngine>>()
  let disposed = false

  async function start(variant: GameEngineVariant, config: EngineConfig): Promise<RunningEngine> {
    let reportDeath = () => {}
    const death = new Promise<never>((_, reject) => {
      reportDeath = () => reject(new Error(`engine process for "${variant}" exited`))
    })
    // Nothing may be racing when the process dies idle; swallow so an unraced
    // rejection can't crash the service.
    death.catch(() => {})

    const transport = await spawnUciTransport(config, () => {
      // Process death invalidates the cached engine so the next request
      // respawns instead of writing into a dead pipe.
      running.delete(variant)
      reportDeath()
    })

    try {
      await uciHandshake(transport, {
        setup: (send) => {
          for (const [name, value] of Object.entries(config.options ?? {})) {
            send(`setoption name ${name} value ${value}`)
          }
        },
      })
    }
    catch (error) {
      transport.dispose()
      throw error
    }

    return { transport, queue: Promise.resolve(), death }
  }

  async function analyzeOnce(variant: GameEngineVariant, config: EngineConfig, fen: string, options: AnalyzeOptions): Promise<RawAnalysis> {
    let starting = running.get(variant)
    if (!starting) {
      starting = start(variant, config)
      running.set(variant, starting)
      // A failed start must not poison the cache: evict so later requests retry.
      starting.catch(() => running.delete(variant))
    }
    const engine = await starting

    const run = engine.queue.then(() => Promise.race([
      analyzeViaUci(engine.transport, fen, options),
      engine.death,
    ]))
    // The queue must survive a failed analyze; errors surface via `run` only.
    engine.queue = run.catch(() => {})
    return run
  }

  return {
    /**
     * Analyzes `fen` on the variant's engine, queueing behind any in-flight
     * search. A dead or dying engine is respawned and the request retried
     * once; a second failure (or an unconfigured variant) throws, and callers
     * turn that into an error reply.
     */
    async analyze(variant: GameEngineVariant, fen: string, options: AnalyzeOptions): Promise<RawAnalysis> {
      if (disposed) {
        throw new Error('engine pool disposed')
      }
      const config = configs[variant]
      if (!config) {
        throw new Error(`no engine configured for variant "${variant}"`)
      }

      try {
        return await analyzeOnce(variant, config, fen, options)
      }
      catch (error) {
        if (disposed) {
          throw error
        }
        // One retry on a fresh spawn: a crash between/under requests would
        // otherwise fail work a healthy respawned engine could serve.
        return analyzeOnce(variant, config, fen, options)
      }
    },

    dispose() {
      disposed = true
      for (const starting of running.values()) {
        starting.then(engine => engine.transport.dispose(), () => {})
      }
      running.clear()
    },
  }
}

/**
 * Spawns a UCI engine child process and wraps its stdio as a {@link UciTransport}.
 *
 * Resolves once the process has actually started (`spawn` event); rejects on
 * launch failure (e.g. ENOENT for a missing binary). `onExit` fires exactly
 * once when the process ends for any reason after that.
 *
 * The child's cwd is the binary's directory so engines that resolve companion
 * files relatively (Pikafish's default `pikafish.nnue` lookup) find them next
 * to the binary even when `EvalFile` is not configured.
 */
export function spawnUciTransport(config: EngineConfig, onExit?: () => void): Promise<UciTransport> {
  return new Promise<UciTransport>((resolve, reject) => {
    const cwd = config.binary.includes('/') ? dirname(config.binary) : undefined
    const child: ChildProcessWithoutNullStreams = spawn(config.binary, config.args ?? [], { cwd, stdio: 'pipe' })

    const listeners = new Set<(line: string) => void>()
    let stdoutRest = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      // Line-buffer stdout: chunks split mid-line, so keep the unterminated
      // tail until the next chunk completes it.
      const lines = (stdoutRest + chunk).split('\n')
      stdoutRest = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed) {
          for (const listener of listeners) {
            listener(trimmed)
          }
        }
      }
    })

    // 'error' (failed launch) and 'exit' can both fire for one process; the
    // documented exactly-once onExit needs the guard.
    let exited = false
    const fireExit = () => {
      if (!exited) {
        exited = true
        onExit?.()
      }
    }
    child.once('error', (error) => {
      reject(error)
      fireExit()
    })
    child.once('exit', fireExit)
    child.once('spawn', () => {
      resolve({
        send: (command) => {
          child.stdin.write(`${command}\n`)
        },
        onLine: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        dispose: () => {
          listeners.clear()
          // `quit` lets the engine exit cleanly; the kill is the backstop for
          // an engine stuck in a search.
          try {
            child.stdin.write('quit\n')
          }
          catch {}
          setTimeout(() => child.kill(), 1000).unref()
        },
      })
    })
  })
}
