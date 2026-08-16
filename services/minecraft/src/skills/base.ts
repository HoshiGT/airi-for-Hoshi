import type { Mineflayer } from '../libs/mineflayer'

import { useLogger } from '../utils/logger'

const logger = useLogger()

/**
 * Log a message to the context's output buffer
 */
export function log(_mineflayer: Mineflayer, message: string): void {
  logger.log(message)
  // mineflayer.bot.chat(message)
}

/**
 * Position in the world
 */
export interface Position {
  x: number
  y: number
  z: number
}

/**
 * Block face direction
 */
export type BlockFace = 'top' | 'bottom' | 'north' | 'south' | 'east' | 'west' | 'side'

/**
 * A resource the skill needed but could not obtain.
 */
export interface MissingResource {
  item: string
  need: number
  have: number
}

/**
 * Structured skill outcome.
 *
 * NOTICE: why this shape rather than `boolean` or a thrown `ActionError`.
 *
 * The conscious layer runs LLM-authored JavaScript in a sandbox; every tool call is funnelled
 * through `JavaScriptPlanner.executeTool` (`cognitive/conscious/js-planner.ts`). When a tool throws,
 * that catch block keeps only `errorMessageFrom(error)` — a bare string — so an `ActionError`'s
 * `code` and `context` never reach the model. A returned object, by contrast, is preserved intact
 * as `ActionRuntimeResult.result`.
 *
 * So: predictable failures (missing item, no target in range, wrong block type) return
 * `{ ok: false, reason, message, missing }` and let the model see exactly what is lacking.
 * Only genuinely exceptional conditions (interrupts, invalid params) should still throw.
 *
 * `reason` is a stable machine-readable code; `message` is the human/LLM-readable sentence.
 */
export interface SkillResult {
  ok: boolean
  reason: string
  message: string
  missing?: MissingResource[]
  detail?: Record<string, unknown>
}

export function skillOk(message: string, detail?: Record<string, unknown>): SkillResult {
  return detail ? { ok: true, reason: 'success', message, detail } : { ok: true, reason: 'success', message }
}

export function skillFail(
  reason: string,
  message: string,
  extra?: { missing?: MissingResource[], detail?: Record<string, unknown> },
): SkillResult {
  const result: SkillResult = { ok: false, reason, message }
  if (extra?.missing?.length)
    result.missing = extra.missing
  if (extra?.detail)
    result.detail = extra.detail
  return result
}
