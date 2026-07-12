import type { LlmStreamingControlParser, LlmStreamingControlTokenAct } from '../types'

// NOTICE:
// The canonical form is `<|ACT {...}|>`, but weaker models frequently emit
// `<|ACT: {...}|>` / `<|ACT:{...}|>`. We tolerate the colon variant as long
// as the payload is still a JSON object literal, matching the leniency of the
// emotion queue regex in `packages/stage-ui/src/composables/queues.ts`.
// Removal condition: all supported models reliably emit the canonical form.
const actTokenPattern = /^<\|ACT\s*(?::\s*)?(\{[\s\S]*\})\s*\|>$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Creates the parser for `<|ACT {...}|>` streaming-control tokens.
 *
 * Use when:
 * - Loading the built-in performance action control
 *
 * Expects:
 * - The token body is a JSON object literal
 *
 * Returns:
 * - Parsed action data with no side effects
 */
export function tokenAct(): LlmStreamingControlParser<LlmStreamingControlTokenAct> {
  return {
    name: 'ACT',
    match(special) {
      return actTokenPattern.test(special.trim())
    },
    parse(special) {
      const rawPayload = actTokenPattern.exec(special.trim())?.[1] ?? ''

      let parsed: unknown
      try {
        parsed = JSON.parse(rawPayload)
      }
      catch {
        return undefined
      }

      if (!isPlainObject(parsed)) {
        return undefined
      }

      return {
        type: 'act',
        payload: parsed,
      }
    },
  }
}
