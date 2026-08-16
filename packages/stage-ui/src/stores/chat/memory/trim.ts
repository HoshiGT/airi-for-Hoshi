import type { Message } from '@xsai/shared-chat'

import type { ChatHistoryItem } from '../../../types/chat'

type ProviderHistoryMessage = Exclude<ChatHistoryItem, { role: 'error' }>

/**
 * Strips UI-only `error` entries so the history is valid provider input.
 *
 * Shared by the classic consolidation flow, the layered passes, and the
 * manual-consolidation maintenance store — lives here (the memory trim/plan
 * module) so the memory service can convert rounds without importing the
 * orchestrator store (which would be circular).
 */
export function toProviderHistory(messages: ChatHistoryItem[]): Message[] {
  return messages.filter((message): message is ProviderHistoryMessage => message.role !== 'error')
}

/**
 * A consolidation plan derived purely from the live session message list:
 * which messages to archive and how to locate them for removal.
 *
 * Computing this is side-effect free (no store, DB, or model call) so the
 * round-counting and trimming policy can be unit-tested in isolation.
 */
export interface ConsolidationPlan {
  /**
   * Oldest messages to summarize and archive. Whether they are also removed from
   * the live context is the caller's decision (see `trimAfterConsolidation`);
   * this plan only says which rounds the pass covers.
   */
  archived: ChatHistoryItem[]
  /**
   * Ids of the archived messages. A trimming caller removes by id rather than by
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
 *
 * Exported because round numbers are a cross-module contract, not a trimming
 * detail: `memory_items.source_round_from` / `archived_summaries.round_from` are
 * persisted with this numbering, and history search reports and re-reads rounds
 * by it. Any other definition of "round" would make those references point at
 * different messages.
 */
export function splitRounds(messages: ChatHistoryItem[]): { head: ChatHistoryItem[], rounds: ChatHistoryItem[][] } {
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
 * oldest rounds to summarize.
 *
 * Returns `null` when the live round count is still below `triggerRounds`, when
 * everything still fits the retained window, or when too few rounds have
 * accumulated since the previous pass — in all three cases the caller leaves the
 * conversation untouched.
 *
 * Omitting `triggerRounds` skips the high-water gate entirely — that is the
 * manual "consolidate now" path, which compresses everything older than the
 * retained window regardless of how short the conversation still is.
 *
 * `consolidatedThroughRound` is what makes a non-trimming pass safe to repeat:
 * when archived rounds stay in the live list, round N is still round N next
 * time, so a pass must start after the last round already summarized or it will
 * distill the same conversation over and over. In trimming mode the caller
 * leaves it at 0, because the trimmed rounds are simply gone.
 *
 * `minNewRounds` is the batch size gate for the same reason: without trimming,
 * every new turn pushes one more round past the retained window, and a pass per
 * turn would mean a model call per turn.
 */
export function planConsolidation(
  messages: ChatHistoryItem[],
  options: {
    triggerRounds?: number
    retainRounds: number
    /** Rounds 1..N have already been summarized by an earlier pass. @default 0 */
    consolidatedThroughRound?: number
    /** Minimum unsummarized rounds before a pass is worth running. @default 1 */
    minNewRounds?: number
  },
): ConsolidationPlan | null {
  const { triggerRounds, retainRounds, consolidatedThroughRound = 0, minNewRounds = 1 } = options
  const { rounds } = splitRounds(messages)

  if (triggerRounds !== undefined && rounds.length < triggerRounds)
    return null

  // Everything up to here is old enough to summarize; the newest `retainRounds`
  // stay untouched either way.
  const archiveThrough = rounds.length - retainRounds
  if (archiveThrough <= 0)
    return null

  const startRound = Math.max(consolidatedThroughRound, 0)
  const newRounds = archiveThrough - startRound
  if (newRounds < Math.max(minNewRounds, 1))
    return null

  const archived = rounds.slice(startRound, archiveThrough).flat()
  const archivedIds = new Set(
    archived.map(message => message.id).filter((id): id is string => !!id),
  )

  return {
    archived,
    archivedIds,
    roundFrom: startRound + 1,
    roundTo: archiveThrough,
  }
}
