import type { Difficulty, Variant } from '../shared/types'
import type { AnalyzeOptions, RawAnalysis } from './uci'

import { createChessEngine } from './chess'
import { createXiangqiEngine } from './xiangqi'

export type { AnalyzeOptions, RawAnalysis, RawCandidate, UciTransport } from './uci'

/** A loaded local engine that can analyse positions and be torn down. */
export interface EngineAdapter {
  analyze: (fen: string, options: AnalyzeOptions) => Promise<RawAnalysis>
  dispose: () => void
}

/**
 * Per-difficulty search profile.
 *
 * `movetimeMs` is the engine's thinking time. `candidates` is how many ranked
 * moves Airi is offered: more candidates on lower difficulty widen the room for
 * Airi to pick a weaker, more human move; fewer on `hard` keep play near best.
 */
export interface DifficultyProfile {
  movetimeMs: number
  candidates: number
}

const PROFILES: Record<Difficulty, DifficultyProfile> = {
  easy: { movetimeMs: 200, candidates: 5 },
  normal: { movetimeMs: 600, candidates: 5 },
  hard: { movetimeMs: 1500, candidates: 3 },
}

/** Returns the search/selection profile for a difficulty band. */
export function difficultyProfile(difficulty: Difficulty): DifficultyProfile {
  return PROFILES[difficulty]
}

/** Loads the local WASM engine for a variant. Reuse one instance per match. */
export async function createEngine(variant: Variant): Promise<EngineAdapter> {
  if (variant === 'xiangqi') {
    return await createXiangqiEngine()
  }
  return await createChessEngine()
}
