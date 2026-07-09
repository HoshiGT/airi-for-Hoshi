import type { ChatHistoryItem } from '../../../types/chat'

/**
 * A consolidation plan derived purely from the live session message list:
 * which messages to archive and how to locate them for removal.
 *
 * Computing this is side-effect free (no store, DB, or model call) so the
 * round-counting and trimming policy can be unit-tested in isolation.
 */
export interface ConsolidationPlan {
  /** Oldest messages to summarize + archive, then remove from live context. */
  archived: ChatHistoryItem[]
  /**
   * Ids of the archived messages. The caller trims by id rather than by
   * slicing, so messages appended while the async consolidation runs keep
   * their place and are never dropped.
   */
  archivedIds: Set<string>
  /** Inclusive 1-based round range the archived messages span, for drill-back. */
  roundFrom: number
  roundTo: number
}

/**
 * Splits history into the leading system preamble and the user-delimited rounds.
 *
 * A round starts at each `user` message and runs until the next one, so the
 * assistant reply and any interleaved `tool` messages stay grouped with the
 * user turn that produced them. Leading non-user messages (the system prompt,
 * stray context injected before the first turn) are returned as `head` and are
 * never counted as a round.
 */
function splitRounds(messages: ChatHistoryItem[]): { head: ChatHistoryItem[], rounds: ChatHistoryItem[][] } {
  const firstUser = messages.findIndex(message => message.role === 'user')
  if (firstUser === -1)
    return { head: messages.slice(), rounds: [] }

  const head = messages.slice(0, firstUser)
  const rounds: ChatHistoryItem[][] = []
  for (const message of messages.slice(firstUser)) {
    if (message.role === 'user')
      rounds.push([message])
    else
      rounds[rounds.length - 1].push(message)
  }
  return { head, rounds }
}

/**
 * Decides whether the session is due for consolidation and, if so, which
 * oldest rounds to archive.
 *
 * Returns `null` when the live round count is still below `triggerRounds` or
 * there is nothing to trim, so the caller leaves the conversation untouched.
 * Otherwise the oldest `roundCount - retainRounds` rounds are marked for
 * archival; everything newer plus the system head stays live.
 *
 * Omitting `triggerRounds` skips the high-water gate entirely — that is the
 * manual "consolidate now" path, which compresses everything older than the
 * retained window regardless of how short the conversation still is.
 */
export function planConsolidation(
  messages: ChatHistoryItem[],
  options: { triggerRounds?: number, retainRounds: number },
): ConsolidationPlan | null {
  const { triggerRounds, retainRounds } = options
  const { rounds } = splitRounds(messages)

  if (triggerRounds !== undefined && rounds.length < triggerRounds)
    return null

  const overflow = rounds.length - retainRounds
  if (overflow <= 0)
    return null

  const archived = rounds.slice(0, overflow).flat()
  const archivedIds = new Set(
    archived.map(message => message.id).filter((id): id is string => !!id),
  )

  return {
    archived,
    archivedIds,
    roundFrom: 1,
    roundTo: overflow,
  }
}
