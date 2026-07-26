import { definePerceptionEvent } from '..'

// ---------------------------------------------------------------------------------------------
// NOTICE: server system messages are throttled here, not in the rule.
//
// Every `messagestr` with position 'system' used to become one raw event, and the rule's
// `threshold: 1 / window: 1s` let every single one through — one full LLM round trip each. A
// server that broadcasts join/leave notices, advancements, death messages or a plugin's periodic
// announcements would wake the brain continuously, for messages it has no reason to act on.
//
// The gate is: anything naming the bot always passes (someone is talking to or about us, which may
// need a reply), and everything else passes at most once per cooldown window so the bot keeps some
// awareness of server chatter without paying per line.
//
// A YAML `detector` cannot express this — threshold/window mean "fire once N have arrived", which
// is the opposite of a rate limit.
// ---------------------------------------------------------------------------------------------

/** Minimum spacing between unaddressed system messages reaching the brain. */
const GENERIC_MESSAGE_COOLDOWN_MS = 30_000

let lastGenericMessageAt = 0

/** Test-only: the cooldown is module state and would otherwise leak between cases. */
export function __resetSystemMessageThrottleForTests(): void {
  lastGenericMessageAt = 0
}

function mentionsSelf(message: string, selfUsername: string): boolean {
  if (!selfUsername)
    return false
  return message.toLowerCase().includes(selfUsername.toLowerCase())
}

export const systemMessageEvent = definePerceptionEvent<[string, string], { message: string, position: string }>({
  id: 'system_message',
  modality: 'system',
  kind: 'system_message',

  mineflayer: {
    event: 'messagestr',
    filter: (ctx, message, position) => {
      if (position !== 'system')
        return false

      if (mentionsSelf(message ?? '', ctx.selfUsername))
        return true

      const now = Date.now()
      if (now - lastGenericMessageAt < GENERIC_MESSAGE_COOLDOWN_MS)
        return false

      lastGenericMessageAt = now
      return true
    },
    extract: (_ctx, message, position) => ({ message, position }),
  },

})
