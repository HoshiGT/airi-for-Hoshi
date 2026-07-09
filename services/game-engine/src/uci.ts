import type { GameEngineCandidate } from '@proj-airi/plugin-protocol/types'

/**
 * UCI protocol driver shared by both native engines.
 *
 * Stockfish (chess) and Pikafish (xiangqi) both speak UCI, so the handshake,
 * search driver and line parsing live here once and the engine layer only
 * differs in how it transports text to/from the child process.
 *
 * NOTICE:
 * Adapted from `plugins/airi-plugin-game-chess/src/engines/uci.ts` (same
 * parsing, WASM worker transport there vs child-process stdio here, plus a
 * handshake timeout that a local WASM engine did not need). Consolidating the
 * plugin / stage-ui / service engine cores into one package is a tracked
 * follow-up; until then keep fixes in sync with the plugin copy.
 */

/** Transport that carries UCI text to and from one engine instance. */
export interface UciTransport {
  /** Sends one UCI command line to the engine. */
  send: (command: string) => void
  /** Subscribes to engine output lines; returns an unsubscribe function. */
  onLine: (listener: (line: string) => void) => () => void
  /** Terminates the engine and releases its resources. */
  dispose: () => void
}

/** Search budget for one analysis request. */
export interface AnalyzeOptions {
  /** Number of principal variations (candidate moves) to return. */
  multiPv: number
  /** Fixed thinking time in milliseconds; takes precedence over `depth`. */
  movetimeMs?: number
  /** Fixed search depth used when `movetimeMs` is omitted. */
  depth?: number
}

/** Engine search result: the chosen move plus its ranked alternatives. */
export interface RawAnalysis {
  best: string
  candidates: GameEngineCandidate[]
}

interface ParsedInfo {
  multipv: number
  scoreCp?: number
  mate?: number
  /** First move of the principal variation, i.e. the candidate move itself. */
  pvFirst?: string
}

/**
 * Parses a UCI `info` line into the fields needed for MultiPV ranking.
 *
 * Returns `null` for `info` lines without a principal variation (e.g. periodic
 * `info depth … currmove …` progress lines), which carry no candidate move.
 *
 * Before:
 * - `"info depth 12 multipv 2 score cp -18 pv e7e5 g1f3"`
 *
 * After:
 * - `{ multipv: 2, scoreCp: -18, pvFirst: "e7e5" }`
 */
export function parseInfoLine(line: string): ParsedInfo | null {
  if (!line.startsWith('info ')) {
    return null
  }

  const tokens = line.split(/\s+/)
  let multipv = 1
  let scoreCp: number | undefined
  let mate: number | undefined
  let pvFirst: string | undefined

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === 'multipv') {
      multipv = Number(tokens[i + 1])
    }
    else if (token === 'score') {
      // `score cp <n>` or `score mate <n>`; the kind is the next token.
      if (tokens[i + 1] === 'cp') {
        scoreCp = Number(tokens[i + 2])
      }
      else if (tokens[i + 1] === 'mate') {
        mate = Number(tokens[i + 2])
      }
    }
    else if (token === 'pv') {
      pvFirst = tokens[i + 1]
      break
    }
  }

  if (!pvFirst) {
    return null
  }
  return { multipv, scoreCp, mate, pvFirst }
}

/**
 * Parses a UCI `bestmove` line. Returns `null` when the line reports `(none)`
 * (no legal move, i.e. mate/stalemate) so callers can fall back deliberately.
 */
export function parseBestMove(line: string): string | null {
  const match = line.trim().match(/^bestmove\s+(\S+)/)
  if (!match) {
    return null
  }
  return match[1] === '(none)' ? null : match[1]
}

/**
 * Performs the UCI startup handshake: `uci` → `uciok` → optional engine setup →
 * `isready` → `readyok`. Engine-specific options (EvalFile, thread count) are
 * applied in `setup` after `uciok`, when the engine accepts `setoption`.
 *
 * Rejects after `timeoutMs`: a child process that never answers `uci` is not a
 * UCI engine (wrong binary, crashed on start), and callers must surface that
 * instead of queueing requests forever.
 */
export function uciHandshake(
  transport: UciTransport,
  options?: {
    setup?: (send: UciTransport['send']) => void
    /** @default 15_000 (Pikafish loads a 50MB+ NNUE net before readyok) */
    timeoutMs?: number
  },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let unsubscribe: () => void = () => {}
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('UCI handshake timed out'))
    }, options?.timeoutMs ?? 15_000)

    unsubscribe = transport.onLine((line) => {
      if (line.startsWith('uciok')) {
        options?.setup?.(transport.send)
        transport.send('isready')
      }
      else if (line.startsWith('readyok')) {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
    })
    transport.send('uci')
  })
}

/**
 * Drives one MultiPV search to completion over a {@link UciTransport}.
 *
 * It keeps the latest evaluation per MultiPV rank (UCI emits each rank
 * repeatedly as the search deepens), then resolves on `bestmove` with the
 * ranked candidates. A safety timer resolves with whatever was collected if the
 * engine never emits `bestmove`.
 */
export function analyzeViaUci(
  transport: UciTransport,
  fen: string,
  options: AnalyzeOptions,
): Promise<RawAnalysis> {
  const multiPv = Math.max(1, options.multiPv)
  const latestByRank = new Map<number, GameEngineCandidate>()

  return new Promise<RawAnalysis>((resolve) => {
    let unsubscribe: () => void = () => {}
    let timer: ReturnType<typeof setTimeout>

    function finish(best: string | null) {
      unsubscribe()
      clearTimeout(timer)
      const candidates = [...latestByRank.values()]
        .sort((a, b) => a.rank - b.rank)
        .slice(0, multiPv)
      resolve({ best: best ?? candidates[0]?.uci ?? '', candidates })
    }

    unsubscribe = transport.onLine((line) => {
      const info = parseInfoLine(line)
      if (info?.pvFirst) {
        latestByRank.set(info.multipv, {
          uci: info.pvFirst,
          rank: info.multipv,
          scoreCp: info.scoreCp,
          mate: info.mate,
        })
        return
      }

      if (line.startsWith('bestmove')) {
        finish(parseBestMove(line))
      }
    })

    // Budget plus headroom for engine wind-down; guards against a missing bestmove.
    const budgetMs = options.movetimeMs ?? 4000
    timer = setTimeout(finish, budgetMs + 4000, null)

    transport.send(`setoption name MultiPV value ${multiPv}`)
    transport.send(`position fen ${fen}`)
    transport.send(
      options.movetimeMs != null
        ? `go movetime ${options.movetimeMs}`
        : `go depth ${options.depth ?? 12}`,
    )
  })
}
