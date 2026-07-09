import type { RawCandidate } from './engine'
import type { Side } from './shared'
import type { PlyRecord } from './use-chess-game'

/**
 * Post-game review math (chess.com-style 复盘): given one engine evaluation per
 * position, grade every played move by how much evaluation it gave away
 * compared to the engine's best move from the same position.
 *
 * All the engine IO (replaying the game, analyzing each position) lives in
 * `use-game-review.ts`; this module is pure so the grading rules are testable
 * without an engine.
 */

/** Quality grade for one played move, best → worst. */
export type MoveQuality = 'best' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'

/** Display metadata per grade, in grade order. Colors follow chess.com's idiom: green = fine, orange = dubious, red = losing. */
export const QUALITY_META: Record<MoveQuality, { label: string, symbol: string }> = {
  best: { label: '最佳', symbol: '★' },
  excellent: { label: '优秀', symbol: '!' },
  good: { label: '良好', symbol: '✓' },
  inaccuracy: { label: '失误', symbol: '?!' },
  mistake: { label: '错误', symbol: '?' },
  blunder: { label: '漏着', symbol: '??' },
}

// Centipawn-loss thresholds per grade (exclusive upper bounds, lichess-like).
// A move matching the engine's first choice is 'best' regardless of noise.
const GRADE_BOUNDS: { quality: MoveQuality, below: number }[] = [
  { quality: 'best', below: 15 },
  { quality: 'excellent', below: 40 },
  { quality: 'good', below: 90 },
  { quality: 'inaccuracy', below: 180 },
  { quality: 'mistake', below: 350 },
  { quality: 'blunder', below: Number.POSITIVE_INFINITY },
]

// Forced mate expressed in centipawns for loss arithmetic: mate-in-1 sits just
// under this ceiling and longer mates score progressively lower, so trading a
// short mate for a longer one still registers as a (small) loss.
const MATE_CP = 10_000

/**
 * A candidate's evaluation as one centipawn number from the mover's
 * perspective, folding mate scores under {@link MATE_CP}.
 */
export function moverEvalCp(candidate: Pick<RawCandidate, 'scoreCp' | 'mate'>): number {
  if (candidate.mate != null) {
    return candidate.mate >= 0 ? MATE_CP - candidate.mate : -MATE_CP - candidate.mate
  }
  return candidate.scoreCp ?? 0
}

/** Grades one move from its centipawn loss (see {@link GRADE_BOUNDS}). */
export function classifyCpLoss(cpLoss: number, playedBest: boolean): MoveQuality {
  if (playedBest) {
    return 'best'
  }
  return GRADE_BOUNDS.find(bound => cpLoss < bound.below)!.quality
}

/** Everything the engine pass measured about one position, mover's POV. */
export interface PositionAnalysis {
  /** Best-line evaluation from the side to move's perspective. */
  evalCp: number
  /** Engine's preferred move (UI-convention UCI). */
  bestUci: string
  /** SAN of {@link bestUci}, for the "better was …" hint. */
  bestSan: string
}

/** One reviewed move: the played ply plus its grade and evaluations. */
export interface ReviewedPly extends PlyRecord {
  side: Side
  quality: MoveQuality
  /** Evaluation given away vs the engine's best move, ≥ 0. */
  cpLoss: number
  /** Position evaluation after this move, from the FIRST side's POV (graph axis). */
  evalAfterCp: number
  /** Engine's preferred move in this position, when the played move differs. */
  betterSan?: string
}

/** The whole graded game. */
export interface GameReview {
  plies: ReviewedPly[]
  /** Starting-position evaluation from the first side's POV (graph origin). */
  startEvalCp: number
  /** Non-fine move counts per side, for the summary line. */
  counts: Record<Side, Record<'inaccuracy' | 'mistake' | 'blunder', number>>
}

/**
 * Grades a finished game from per-position engine analyses.
 *
 * `positions[i]` analyzes the position BEFORE `plies[i]` (so `positions` and
 * `plies` have equal length); the terminal position after the last move is not
 * analyzed — engines reject finished positions — so its evaluation is derived
 * from `result` ('1-0' / '0-1' / '1/2-1/2': mate scores for the mated side,
 * a draw scores 0).
 *
 * The loss of ply `i` is the standard eval swing: the mover's best-line score
 * at position `i` minus the (negated) opponent's best-line score at position
 * `i + 1`. Using the same engine budget on both positions keeps the two
 * numbers comparable.
 */
export function deriveReview(plies: PlyRecord[], positions: PositionAnalysis[], result: string): GameReview {
  // Mover-POV best-line evaluation per position, including the terminal one.
  const evals = positions.map(position => position.evalCp)
  if (result === '1/2-1/2') {
    evals.push(0)
  }
  else {
    // Decisive result: the side to move in the terminal position is mated.
    evals.push(-MATE_CP)
  }

  const reviewed: ReviewedPly[] = plies.map((ply, index) => {
    const side: Side = index % 2 === 0 ? 'first' : 'second'
    const bestCp = evals[index]
    const playedCp = -evals[index + 1]
    const cpLoss = Math.max(0, bestCp - playedCp)
    const quality = classifyCpLoss(cpLoss, ply.uci === positions[index].bestUci)
    // The position after this ply has the opponent to move; flip to first POV.
    const evalAfterCp = (index + 1) % 2 === 0 ? evals[index + 1] : -evals[index + 1]
    return {
      ...ply,
      side,
      quality,
      cpLoss,
      evalAfterCp,
      betterSan: quality === 'best' ? undefined : positions[index].bestSan,
    }
  })

  const counts: GameReview['counts'] = {
    first: { inaccuracy: 0, mistake: 0, blunder: 0 },
    second: { inaccuracy: 0, mistake: 0, blunder: 0 },
  }
  for (const ply of reviewed) {
    if (ply.quality === 'inaccuracy' || ply.quality === 'mistake' || ply.quality === 'blunder') {
      counts[ply.side][ply.quality] += 1
    }
  }

  // The first side is to move at position 0, so its mover-POV eval IS first-POV.
  return { plies: reviewed, startEvalCp: positions[0]?.evalCp ?? 0, counts }
}
