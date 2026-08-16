/**
 * Layered memory consolidation schedule (L0 → L3).
 *
 * Layers:
 * - L0: raw conversation rounds, kept verbatim in the live session.
 * - L1: structured facts distilled from recent raw rounds, at a warm-up cadence.
 * - L2: scene aggregations over L1 facts (delayed, needs a batch to be useful).
 * - L3: global profile over L2 scenes (character-wide, rarest).
 *
 * Scheduling is hook-driven: the chat orchestrator's turn-completed hook calls
 * into this policy after every reply, and idle sessions simply produce no work
 * ("cold sessions stop polling" for free — there is no timer).
 *
 * This module is side-effect free (no DB, store, or model call) so the cadence
 * policy can be unit-tested in isolation.
 */

/**
 * L1 cadence warm-up: the round interval starts at 1 and doubles after every
 * pass until it caps out, so a brand-new conversation distills eagerly while
 * long-running sessions settle into a slow, cheap rhythm.
 */
export const WARMUP_STEPS = [1, 2, 4, 8] as const

/** Cap for the warm-up interval; doubles stop here. */
export const L1_MAX_WARMUP = 8

/** How many un-aggregated L1 facts must pile up before an L2 scene pass. */
export const L2_BATCH = 8

/** How many un-aggregated L2 scenes must pile up before an L3 profile pass. */
export const L3_BATCH = 6

/** Progress state of one (character, session) layered schedule. */
export interface LayerScheduleState {
  warmupStep: number
  l1RoundsProcessed: number
  l1PassCount: number
}

/** Pending-tier watermarks, derived from `memory_items.aggregated_at`. */
export interface LayerPendingCounts {
  /** Layer-1 facts not yet folded into an L2 scene. */
  l1Pending: number
  /** Layer-2 scenes not yet folded into the L3 profile. */
  l2Pending: number
}

export type LayerAction
  = | { type: 'none' }
  /**
   * Distill the raw rounds in the inclusive 1-based range
   * `(l1RoundsProcessed, roundCount]` into L1 facts.
   */
    | { type: 'l1', roundFrom: number, roundTo: number }
    | { type: 'l2' }
    | { type: 'l3' }

export interface LayerPlanInput extends LayerScheduleState {
  /** Current live round count of the session (1-based, see splitRounds). */
  roundCount: number
  counts: LayerPendingCounts
}

/**
 * Decides which layered pass (if any) is due for a session.
 *
 * Precedence:
 * 1. L1 when enough NEW rounds accumulated (warm-up interval met) — round
 *    processing must not stall behind delayed aggregation passes.
 * 2. L3 when enough L2 scenes await the profile — the rarest tier, run as
 *    soon as its batch fills.
 * 3. L2 when enough L1 facts await scene aggregation.
 *
 * One action per call: each turn-completed hook performs at most one model
 * call, keeping per-turn cost bounded; the next hook picks up the next due
 * pass. When `roundCount < l1RoundsProcessed` (the session history was
 * trimmed/cleared since the last pass), the watermark resets to the current
 * count so numbering stays coherent — the caller persists the reset state.
 */
export function planLayerPass(input: LayerPlanInput): LayerAction {
  const { roundCount, counts, l1RoundsProcessed } = input

  const watermark = roundCount < l1RoundsProcessed ? roundCount : l1RoundsProcessed
  const newRounds = roundCount - watermark

  if (newRounds >= input.warmupStep)
    return { type: 'l1', roundFrom: watermark + 1, roundTo: roundCount }

  if (counts.l2Pending >= L3_BATCH)
    return { type: 'l3' }

  if (counts.l1Pending >= L2_BATCH)
    return { type: 'l2' }

  return { type: 'none' }
}

/**
 * Next warm-up step after a successful L1 pass: double until the cap.
 *
 * Before:
 * - 1, 2, 4
 *
 * After:
 * - 2, 4, 8 (8 stays 8)
 */
export function nextWarmupStep(current: number): number {
  return Math.min(current * 2, L1_MAX_WARMUP)
}

/** Fresh schedule state for a session that has never run a layered pass. */
export function initialLayerState(): LayerScheduleState {
  return {
    warmupStep: WARMUP_STEPS[0],
    l1RoundsProcessed: 0,
    l1PassCount: 0,
  }
}

/**
 * The schedule state after a successful L1 pass over rounds
 * `(roundFrom..roundTo]`.
 */
export function stateAfterL1Pass(
  state: LayerScheduleState,
  roundTo: number,
): LayerScheduleState {
  return {
    warmupStep: nextWarmupStep(state.warmupStep),
    l1RoundsProcessed: roundTo,
    l1PassCount: state.l1PassCount + 1,
  }
}
