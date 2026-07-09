import type { EngineCandidate, Side, Variant } from './types'

import { sideLabel } from './types'

/**
 * Pure logic for the "Airi picks a move" round trip.
 *
 * The local engine produces ranked candidate moves; Airi (the character LLM)
 * chooses one and comments. The choice rides on the host's spark-notify
 * performance channel, which only echoes the resolved call's `name` back to the
 * iframe — not an arbitrary payload. So each candidate is registered as its own
 * named call, and the returned `name` identifies the chosen move.
 *
 * This module is framework-free and unit-tested; the iframe bridge only wires it
 * to the widgets transport.
 */

/** Route namespace for chess move-selection spark-notify traffic. */
export const MOVE_NAMESPACE = 'airi.plugin.game-chess'
/** Route name the host uses when echoing the reaction back to the iframe. */
export const MOVE_RESPONSE_NAME = 'response'

/**
 * Encodes a move's UCI as a performance call name the model can emit.
 *
 * Before:
 * - `"e2e4"` / `"h2e2"`
 *
 * After:
 * - `"play_e2e4"` / `"play_h2e2"`
 */
export function moveCallName(uci: string): string {
  return `play_${uci.replace(/[^a-z0-9]/gi, '').toLowerCase()}`
}

/** Human-readable evaluation for a candidate, from the mover's perspective. */
export function formatEvaluation(candidate: Pick<EngineCandidate, 'scoreCp' | 'mate'>): string {
  if (candidate.mate != null) {
    return candidate.mate >= 0 ? `mate in ${candidate.mate}` : `mated in ${-candidate.mate}`
  }
  if (candidate.scoreCp != null) {
    const pawns = candidate.scoreCp / 100
    const sign = pawns > 0 ? '+' : ''
    return `${sign}${pawns.toFixed(1)}`
  }
  return 'unclear'
}

/** One performance call manifest understood by the host spark-notify bridge. */
export interface MoveCall {
  name: string
  prompt: string
  examples?: string[]
}

/** spark-notify request envelope published from the iframe to the host. */
export interface MoveRequestEnvelope {
  route: { namespace: string }
  payload: {
    requestId: string
    fallbackResponseText: string
    responseRoute: { namespace: string, name: string }
    timeoutMs: number
    calls: MoveCall[]
    sparkNotify: {
      headline: string
      kind: string
      urgency: string
      destinations: string[]
      payload: Record<string, unknown>
    }
  }
}

export interface MoveRequestInput {
  variant: Variant
  airiSide: Side
  fen: string
  /** SAN-enriched, rank-ordered candidate moves from the engine. */
  candidates: EngineCandidate[]
  requestId: string
  /** Spoken text used when Airi produces no reaction in time. */
  fallbackResponseText: string
  /** How long the host waits for Airi to react before timing out. */
  timeoutMs?: number
}

/**
 * Builds the spark-notify envelope offering the candidate moves to Airi.
 *
 * Each candidate becomes a named call; the headline and payload give Airi the
 * board context needed to comment in character.
 */
export function buildMoveRequest(input: MoveRequestInput): MoveRequestEnvelope {
  const colour = sideLabel(input.variant, input.airiSide)
  const game = input.variant === 'xiangqi' ? 'Chinese chess' : 'chess'

  const calls = input.candidates.map(candidate => ({
    name: moveCallName(candidate.uci),
    prompt: `Play ${candidate.san} (engine rank #${candidate.rank}, eval ${formatEvaluation(candidate)}).`,
  } satisfies MoveCall))

  return {
    route: { namespace: MOVE_NAMESPACE },
    payload: {
      requestId: input.requestId,
      fallbackResponseText: input.fallbackResponseText,
      responseRoute: { namespace: MOVE_NAMESPACE, name: MOVE_RESPONSE_NAME },
      timeoutMs: input.timeoutMs ?? 8000,
      calls,
      sparkNotify: {
        headline: `It's your move in ${game} — you play ${colour}.`,
        kind: 'ping',
        urgency: 'immediate',
        destinations: ['character'],
        payload: {
          variant: input.variant,
          fen: input.fen,
          airiSide: input.airiSide,
          candidates: input.candidates.map(candidate => ({
            san: candidate.san,
            uci: candidate.uci,
            rank: candidate.rank,
            evaluation: formatEvaluation(candidate),
          })),
        },
      },
    },
  }
}

/** Terminal reaction echoed by the host for one move request. */
export interface MoveResponse {
  performance?: { type: string, name?: string }
  text?: string
}

/** Outcome of resolving Airi's reaction into a concrete move. */
export interface MoveDecision {
  /** UCI of the move to play. */
  uci: string
  /** Commentary to surface; the reaction text, or the fallback. */
  commentary: string
  /** `airi` when Airi chose via a call; `fallback` when the engine best was used. */
  source: 'airi' | 'fallback'
}

/**
 * Resolves Airi's reaction into the move to play.
 *
 * When Airi emits a move call (`performance.type === 'called'`), its `name` is
 * matched back to a candidate. Otherwise — no reaction, timeout, or a call that
 * matches no candidate — the engine's best candidate is played so the game never
 * stalls. `candidates` must be rank-ordered (rank 1 first).
 */
export function resolveMove(
  response: MoveResponse,
  candidates: EngineCandidate[],
  fallbackText: string,
): MoveDecision {
  const commentary = response.text?.trim() ? response.text.trim() : fallbackText
  const best = candidates[0]?.uci ?? ''

  if (response.performance?.type === 'called' && response.performance.name) {
    const chosen = candidates.find(candidate => moveCallName(candidate.uci) === response.performance!.name)
    if (chosen) {
      return { uci: chosen.uci, commentary, source: 'airi' }
    }
  }

  return { uci: best, commentary, source: 'fallback' }
}
