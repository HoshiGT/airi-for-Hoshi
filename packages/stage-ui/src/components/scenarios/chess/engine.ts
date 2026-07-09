import type { Variant } from './shared'

import { ffishModule, uciFromFfish } from './ffish-module'

/**
 * In-app move engine: a depth-limited alpha-beta search over ffish move
 * generation.
 *
 * Why a built-in search instead of Fairy-Stockfish: the Fairy-Stockfish WASM
 * engine is a pthread build that requires `SharedArrayBuffer` (a shared
 * `WebAssembly.Memory`), which needs cross-origin isolation (COOP/COEP) the app
 * does not set. ffish itself is single-threaded, so rules + this search run
 * fully locally in any context without special headers or served engine files.
 */

/** One engine candidate before SAN enrichment by the rules layer. */
export interface RawCandidate {
  uci: string
  /** 1-based rank; rank 1 is the engine's preferred move. */
  rank: number
  scoreCp?: number
  mate?: number
}

/** Engine search result: the chosen move plus its ranked alternatives. */
export interface RawAnalysis {
  best: string
  candidates: RawCandidate[]
}

/** A loaded engine that can analyse positions for a variant. */
export interface EngineAdapter {
  analyze: (fen: string) => Promise<RawAnalysis>
  dispose: () => void
}

/**
 * Fixed search budget. Strength is no longer chosen here — the engine always
 * searches at one sensible depth and returns a spread of candidates, and the
 * adaptive move policy (`selectMove` in move-policy.ts) decides how hard Airi plays
 * from the player's declared level. A wider candidate spread gives that policy
 * room to ease toward a weaker, more human move.
 */
const PROFILE = { maxDepth: 3, movetimeMs: 800, candidates: 5 } as const

// Board geometry per variant, used by the positional term to locate the centre.
const GEOMETRY: Record<Variant, { cols: number, rows: number }> = {
  chess: { cols: 8, rows: 8 },
  xiangqi: { cols: 9, rows: 10 },
}

// Material values in centipawns, by role letter, per variant. Kings score 0;
// losing the king is handled by checkmate detection, not material.
const MATERIAL: Record<Variant, Record<string, number>> = {
  chess: { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 },
  xiangqi: { p: 100, a: 200, b: 200, n: 400, r: 900, c: 450, k: 0 },
}

// A mate is scored just below this, offset by ply so shorter mates are preferred.
const MATE = 100_000

// Max centipawn bonus for a perfectly central piece, tapering to 0 at the rim.
// NOTICE: without any positional term, every quiet opening move scores equal on
// material alone, so the search returns the first legal move every time — which
// is the a-file pawn (the board would "一直走 a7 兵"). A small centralization
// term gives quiet moves distinct scores so development/centre play is preferred.
const CENTER_WEIGHT = 30

// Random centipawn spread added to each root move so near-equal positions don't
// always resolve to the same move — keeps games from being identical.
const ROOT_JITTER_CP = 8

/**
 * Centralization bonus for one piece, in centipawns: pieces closer to the board
 * centre score higher. Kings are exempt — centralizing the king mid-game is bad.
 */
function positionalBonus(role: string, col: number, row: number, cols: number, rows: number): number {
  if (role === 'k') {
    return 0
  }
  const cx = (cols - 1) / 2
  const cy = (rows - 1) / 2
  const maxDist = cx + cy
  const dist = Math.abs(col - cx) + Math.abs(row - cy)
  return Math.round(((maxDist - dist) / maxDist) * CENTER_WEIGHT)
}

/**
 * Static evaluation from the side-to-move's perspective, in centipawns:
 * material plus a centralization term. Parses the FEN placement field rank by
 * rank (top rank first) to get each piece's file/rank for the positional term.
 */
function evaluate(fen: string, variant: Variant): number {
  const [placement, active] = fen.trim().split(/\s+/)
  const values = MATERIAL[variant]
  const { cols, rows } = GEOMETRY[variant]
  let score = 0
  placement.split('/').forEach((rankField, row) => {
    let col = 0
    for (const symbol of rankField) {
      if (symbol >= '1' && symbol <= '9') {
        col += Number(symbol)
        continue
      }
      const role = symbol.toLowerCase()
      const value = (values[role] ?? 0) + positionalBonus(role, col, row, cols, rows)
      // Uppercase letters are the first (White/Red) side.
      score += symbol === symbol.toUpperCase() ? value : -value
      col += 1
    }
  })
  // `active` is `w` when the first side is to move.
  return active === 'b' ? -score : score
}

/** ffish board surface used by the search. */
interface SearchBoard {
  legalMoves: () => string
  push: (uci: string) => boolean
  pop: () => void
  isGameOver: (claimDraw?: boolean) => boolean
  isCheck: () => boolean
  isCapture: (uci: string) => boolean
  fen: () => string
  delete: () => void
}

function legalMoveList(board: SearchBoard): string[] {
  const moves = board.legalMoves().trim()
  if (!moves) {
    return []
  }
  const list = moves.split(/\s+/)
  // Search captures first; better move ordering tightens alpha-beta pruning.
  return list.sort((a, b) => Number(board.isCapture(b)) - Number(board.isCapture(a)))
}

/**
 * Negamax with alpha-beta pruning. Returns the value of `board` from the
 * side-to-move's perspective. `ply` is the distance from the search root and is
 * used to prefer faster mates.
 */
function negamax(board: SearchBoard, variant: Variant, depth: number, alpha: number, beta: number, ply: number): number {
  if (board.isGameOver()) {
    // A finished game with the side to move in check is a loss for that side;
    // otherwise it is a draw (stalemate / repetition / material).
    return board.isCheck() ? -(MATE - ply) : 0
  }
  if (depth === 0) {
    return evaluate(board.fen(), variant)
  }

  let best = -Infinity
  for (const uci of legalMoveList(board)) {
    board.push(uci)
    const score = -negamax(board, variant, depth - 1, -beta, -alpha, ply + 1)
    board.pop()
    if (score > best) {
      best = score
    }
    if (best > alpha) {
      alpha = best
    }
    if (alpha >= beta) {
      break
    }
  }
  return best
}

/** Scores every root move at one depth and returns them best-first. */
function searchRoot(board: SearchBoard, variant: Variant, depth: number): { uci: string, score: number }[] {
  const scored = legalMoveList(board).map((uci) => {
    board.push(uci)
    // Jitter only at the root (not inside negamax, which must stay stable) so
    // near-equal candidates shuffle between games instead of always tying to the
    // first legal move.
    const score = -negamax(board, variant, depth - 1, -Infinity, Infinity, 1) + (Math.random() - 0.5) * ROOT_JITTER_CP
    board.pop()
    return { uci, score }
  })
  return scored.sort((a, b) => b.score - a.score)
}

/** Converts a root score into a candidate, expressing near-mate scores as mate. */
function toCandidate(entry: { uci: string, score: number }, rank: number): RawCandidate {
  if (Math.abs(entry.score) >= MATE - 1000) {
    const movesToMate = Math.ceil((MATE - Math.abs(entry.score)) / 2) + 1
    return { uci: entry.uci, rank, mate: entry.score > 0 ? movesToMate : -movesToMate }
  }
  return { uci: entry.uci, rank, scoreCp: entry.score }
}

/**
 * Creates the in-app engine for a variant.
 *
 * The search runs synchronously on the calling thread; the fixed time budget
 * keeps each move within a fraction of a second to about a second.
 */
export async function createEngine(variant: Variant): Promise<EngineAdapter> {
  const ffish = await ffishModule()
  const profile = PROFILE

  return {
    async analyze(fen) {
      // ffish's Board type is a superset of the search surface we use.
      const board: SearchBoard = new ffish.Board(variant, fen)
      try {
        const deadline = Date.now() + profile.movetimeMs
        let scored: { uci: string, score: number }[] = []
        // Iterative deepening: each pass refines ordering and lets us stop on time.
        for (let depth = 1; depth <= profile.maxDepth; depth++) {
          scored = searchRoot(board, variant, depth)
          if (Date.now() > deadline) {
            break
          }
        }
        // The search speaks ffish's own UCIs (push/pop above); only the outgoing
        // candidates cross to the UI convention (0-based xiangqi ranks) so the
        // rules adapter can validate and SAN-enrich them.
        const candidates = scored.slice(0, profile.candidates)
          .map((entry, index) => toCandidate({ ...entry, uci: uciFromFfish(variant, entry.uci) }, index + 1))
        return { best: candidates[0]?.uci ?? '', candidates }
      }
      finally {
        board.delete()
      }
    },
    dispose() {},
  }
}
