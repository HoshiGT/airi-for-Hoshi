import type { EngineCandidate } from './shared'

/**
 * The human's self-declared strength, chosen at the start of a match. It does
 * not change how hard the engine *searches* — it sets how big a lead Airi is
 * willing to hold before easing off, so the game stays competitive for that
 * player.
 */
export type PlayerLevel = 'beginner' | 'novice' | 'amateur' | 'advanced' | 'master'

export const PLAYER_LEVELS: readonly PlayerLevel[] = ['beginner', 'novice', 'amateur', 'advanced', 'master'] as const

/**
 * Target lead (centipawns, from Airi's perspective) that Airi is content to
 * hold against each level. While its best move keeps it above this, it eases
 * back toward the target (放水); at or below it, it plays its best (认真).
 *
 * `master` never eases: an unreachable target means the best move is always at
 * or below it. The lower bands let Airi sit near even or slightly behind so a
 * weaker player can actually win.
 */
const TARGET_LEAD_CP: Record<PlayerLevel, number> = {
  beginner: -60,
  novice: 40,
  amateur: 150,
  advanced: 350,
  master: Number.POSITIVE_INFINITY,
}

// When easing, Airi may give back advantage but must not throw the game: it
// never drops more than this far below its target lead, so an eased move is a
// softer move, not a blunder that hangs material into a loss.
const EASE_FLOOR_SLACK_CP = 150

// Only label a move as eased when it actually concedes at least this much versus
// the best move; smaller gaps count as normal best play.
const EASE_MIN_DROP_CP = 50

// Mate scores dominate any centipawn eval; a faster mate outranks a slower one.
const MATE_CP = 100_000

/** Whether Airi played its best move or deliberately eased (放水). */
export type MoveIntent = 'serious' | 'ease'

/**
 * Airi's move decision plus the evaluation context behind it (Airi's
 * perspective, centipawns). The eval fields record why the move was chosen —
 * which best move was passed up and the lead band aimed for.
 */
export interface MoveChoice {
  uci: string
  san: string
  /** `ease` = deliberately gave back advantage; `serious` = played (near-)best. */
  intent: MoveIntent
  /** Eval of the move actually chosen. */
  chosenCp: number
  /** Eval of the engine's best move; equals `chosenCp` when playing best. */
  bestCp: number
  /** SAN of the engine's best move — what Airi passed up when easing. */
  bestSan: string
  /** The lead band Airi was aiming to hold for the player's level. */
  targetCp: number
}

/** Collapses a candidate's mate/centipawn score into one comparable centipawn value. */
function candidateCp(candidate: EngineCandidate): number {
  if (candidate.mate != null) {
    // Mating in fewer moves scores higher; being mated sooner scores lower.
    return candidate.mate >= 0 ? MATE_CP - candidate.mate : -MATE_CP - candidate.mate
  }
  return candidate.scoreCp ?? 0
}

function toChoice(candidate: EngineCandidate, intent: MoveIntent, chosenCp: number, best: EngineCandidate, targetCp: number): MoveChoice {
  return { uci: candidate.uci, san: candidate.san, intent, chosenCp, bestCp: candidateCp(best), bestSan: best.san, targetCp }
}

/**
 * Picks Airi's move from the engine's ranked candidates given the player's level.
 *
 * Candidates must be best-first with scores from Airi's (the side-to-move's)
 * perspective — exactly what the engine analysis returns on Airi's turn. When
 * Airi's best keeps it above the level's target lead it eases toward that lead
 * (without dropping past the safety floor); otherwise it plays its best.
 *
 * @param candidates Ranked, SAN-enriched engine candidates (rank 1 first).
 * @param level      The human's declared strength.
 */
export function selectMove(candidates: EngineCandidate[], level: PlayerLevel): MoveChoice | null {
  if (candidates.length === 0) {
    return null
  }

  const best = candidates[0]
  const bestCp = candidateCp(best)
  const targetCp = TARGET_LEAD_CP[level]

  // Even or behind relative to the target — Airi cannot afford to ease.
  if (bestCp <= targetCp) {
    return toChoice(best, 'serious', bestCp, best, targetCp)
  }

  // Comfortably ahead: ease toward the target, but stay above the safety floor.
  const floorCp = targetCp - EASE_FLOOR_SLACK_CP
  const eligible = candidates.filter(candidate => candidateCp(candidate) >= floorCp)
  const chosen = eligible.reduce((closest, candidate) =>
    Math.abs(candidateCp(candidate) - targetCp) < Math.abs(candidateCp(closest) - targetCp) ? candidate : closest)

  const chosenCp = candidateCp(chosen)
  const intent: MoveIntent = bestCp - chosenCp >= EASE_MIN_DROP_CP ? 'ease' : 'serious'
  return toChoice(chosen, intent, chosenCp, best, targetCp)
}
