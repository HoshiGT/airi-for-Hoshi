import type { ChatHistoryItem } from '../../../types/chat'
import type { ArchivedSummaryRow } from './schema'

// Imported from the owning module rather than the barrel: `chat-sync/index` also
// re-exports the WebSocket client, which a pure search helper has no business
// pulling into its import graph.
import { extractMessageText } from '../../../libs/chat-sync/wire-message'
import { tokenize } from './repository'
import { splitRounds } from './trim'

/**
 * Only authored turns are searchable. The system preamble is regenerated on
 * every load (so a hit there points at nothing the user ever said), and `tool` /
 * `error` messages are machine payloads that would drown real conversation in
 * JSON.
 */
const SEARCHABLE_ROLES = new Set(['user', 'assistant'])

/** Characters of surrounding text kept on each side of a match in a snippet. */
const SNIPPET_RADIUS = 90
/**
 * Fraction of the query's distinct tokens a message must contain to count as a
 * hit when the query does not appear verbatim.
 *
 * Tuned for the CJK tokenizer: {@link tokenize} emits one token per Han
 * character, so a low threshold would make "上次聊 Android" match any message
 * containing 上, 次 or 聊. Requiring most of the query keeps recall useful
 * without a real index.
 */
const MIN_MATCH_RATIO = 0.6
/** Score added when the query appears verbatim, ranking exact phrases first. */
const VERBATIM_BONUS = 1

/** A conversation the caller made available to search, messages already loaded. */
export interface HistorySessionSource {
  sessionId: string
  title?: string
  /** Last-activity time, used only to break score ties toward recent talk. */
  updatedAt?: number
  messages: ChatHistoryItem[]
}

/** Where a hit came from: a live message, or text only archives still hold. */
export type HistoryHitSource = 'session' | 'archive' | 'archive-summary'

export interface HistoryHit {
  source: HistoryHitSource
  sessionId: string
  sessionTitle?: string
  /** `archived_summaries.id`, set for both archive-backed sources. */
  archiveId?: string
  /** 1-based round (see {@link splitRounds}); null when the range is unknown. */
  round: number | null
  role: string
  /** Message time (epoch ms) when the message carried one. */
  at?: number
  /** Matched text with surrounding context, elided at both ends. */
  snippet: string
  score: number
}

export interface HistorySearchInput {
  sessions: HistorySessionSource[]
  archives: ArchivedSummaryRow[]
}

/**
 * One round of a conversation, as {@link readHistoryRounds} returns it.
 */
export interface HistoryRound {
  round: number
  messages: { role: string, text: string, at?: number }[]
}

/**
 * Archived rows persist their messages as `unknown[]` (jsonb). Narrow them back
 * to chat messages, dropping anything that is not a role-carrying object — a
 * hand-edited or future-schema archive should degrade to "fewer results", never
 * throw mid-search.
 */
function asChatHistoryItems(raw: unknown[]): ChatHistoryItem[] {
  return raw.filter((entry): entry is ChatHistoryItem =>
    !!entry && typeof entry === 'object' && typeof (entry as { role?: unknown }).role === 'string',
  )
}

/**
 * Identity used to suppress an archived copy of a message that is also still in
 * the live session.
 *
 * Consolidation does not trim by default, so most archived rounds are duplicates
 * of live ones; without this the model would see every old turn twice. Message
 * ids are the reliable key — the content fallback exists for messages archived
 * before ids were assigned, where a same-role/same-text pair is a duplicate for
 * search purposes even if it was genuinely typed twice.
 */
function dedupeKey(sessionId: string, message: ChatHistoryItem, text: string): string {
  return message.id ? `id:${message.id}` : `text:${sessionId}:${message.role}:${text}`
}

interface QueryMatcher {
  /** Distinct query tokens; empty means the query had no searchable content. */
  tokens: Set<string>
  /** Lowercased raw query, for the verbatim-substring check. */
  phrase: string
}

function createMatcher(query: string): QueryMatcher {
  return { tokens: new Set(tokenize(query)), phrase: query.trim().toLowerCase() }
}

/**
 * Scores one piece of text against the query, or returns null when it is not a
 * hit. Score is the matched-token ratio plus {@link VERBATIM_BONUS}, so an exact
 * phrase always outranks a scattered token match.
 */
function scoreText(matcher: QueryMatcher, text: string): number | null {
  if (!text)
    return null

  const lowered = text.toLowerCase()
  const verbatim = matcher.phrase.length > 0 && lowered.includes(matcher.phrase)

  const haystack = new Set(tokenize(text))
  let matched = 0
  for (const token of matcher.tokens) {
    if (haystack.has(token))
      matched += 1
  }
  const ratio = matcher.tokens.size > 0 ? matched / matcher.tokens.size : 0

  if (!verbatim && ratio < MIN_MATCH_RATIO)
    return null

  return ratio + (verbatim ? VERBATIM_BONUS : 0)
}

/**
 * Cuts a readable window around the first match so a hit list stays skimmable
 * even when the matched message is a wall of text.
 *
 * Before:
 * - a 2000-character message whose 1200th character starts "Android 的构建"
 *
 * After:
 * - "…前面九十个字符 Android 的构建 后面九十个字符…"
 */
function snippetAround(matcher: QueryMatcher, text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const lowered = collapsed.toLowerCase()

  let at = matcher.phrase ? lowered.indexOf(matcher.phrase) : -1
  if (at === -1) {
    // No verbatim hit: anchor on the earliest single query token instead, which
    // is where a reader would start looking anyway.
    for (const token of matcher.tokens) {
      const found = lowered.indexOf(token)
      if (found !== -1 && (at === -1 || found < at))
        at = found
    }
  }
  if (at === -1)
    at = 0

  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(collapsed.length, at + SNIPPET_RADIUS)
  return `${start > 0 ? '…' : ''}${collapsed.slice(start, end)}${end < collapsed.length ? '…' : ''}`
}

/**
 * Maps each message of a contiguous archived range back to its absolute round
 * number, so an archive hit can be re-read with {@link readHistoryRounds}.
 *
 * The archive stores whole rounds in order starting at `roundFrom`, so the
 * offset is positional. Messages before the first `user` turn (the `head`) have
 * no round and are returned as null.
 */
function roundsByMessage(messages: ChatHistoryItem[], roundFrom: number | null): Map<ChatHistoryItem, number | null> {
  const byMessage = new Map<ChatHistoryItem, number | null>()
  const { head, rounds } = splitRounds(messages)
  for (const message of head)
    byMessage.set(message, null)

  rounds.forEach((round, offset) => {
    const number = roundFrom == null ? null : roundFrom + offset
    for (const message of round)
      byMessage.set(message, number)
  })
  return byMessage
}

/**
 * Keyword search over raw conversation text across every session of one
 * character, plus the archived rounds and summaries that consolidation produced.
 *
 * This is the counterpart to memory recall: recall searches distilled memory
 * items, this searches what was actually said. Matching is the same deliberate
 * keyword approach — no embeddings, no index — so results are deterministic and
 * cheap, at the cost of missing paraphrases.
 *
 * The caller owns scoping: whatever sessions and archives it passes in are the
 * search space, which is how "same character, all sessions" is enforced without
 * this module reaching into stores.
 */
export function searchHistory(input: HistorySearchInput, query: string, limit: number): HistoryHit[] {
  const matcher = createMatcher(query)
  if (matcher.tokens.size === 0)
    return []

  const hits: HistoryHit[] = []
  const seen = new Set<string>()

  for (const session of input.sessions) {
    const rounds = roundsByMessage(session.messages, 1)
    for (const message of session.messages) {
      if (!SEARCHABLE_ROLES.has(message.role))
        continue

      const text = extractMessageText(message)
      seen.add(dedupeKey(session.sessionId, message, text))

      const score = scoreText(matcher, text)
      if (score == null)
        continue

      hits.push({
        source: 'session',
        sessionId: session.sessionId,
        sessionTitle: session.title,
        round: rounds.get(message) ?? null,
        role: message.role,
        at: message.createdAt ?? session.updatedAt,
        snippet: snippetAround(matcher, text),
        score,
      })
    }
  }

  for (const archive of input.archives) {
    const summaryScore = scoreText(matcher, archive.summary)
    if (summaryScore != null) {
      hits.push({
        source: 'archive-summary',
        sessionId: archive.sessionId,
        archiveId: archive.id,
        round: archive.roundFrom,
        role: 'summary',
        at: archive.createdAt.getTime(),
        snippet: snippetAround(matcher, archive.summary),
        score: summaryScore,
      })
    }

    const archived = asChatHistoryItems(archive.rawMessages)
    const rounds = roundsByMessage(archived, archive.roundFrom)
    for (const message of archived) {
      if (!SEARCHABLE_ROLES.has(message.role))
        continue

      const text = extractMessageText(message)
      // Trimming is off by default, so an archived round usually still exists in
      // the live session; only rounds that were actually trimmed reach here.
      const key = dedupeKey(archive.sessionId, message, text)
      if (seen.has(key))
        continue
      seen.add(key)

      const score = scoreText(matcher, text)
      if (score == null)
        continue

      hits.push({
        source: 'archive',
        sessionId: archive.sessionId,
        archiveId: archive.id,
        round: rounds.get(message) ?? null,
        role: message.role,
        at: message.createdAt ?? archive.createdAt.getTime(),
        snippet: snippetAround(matcher, text),
        score,
      })
    }
  }

  // Recency only breaks ties: a strong match in an old conversation is exactly
  // what "what did we say last time" is asking for.
  hits.sort((a, b) => b.score - a.score || (b.at ?? 0) - (a.at ?? 0))
  return hits.slice(0, limit)
}

/**
 * Extracts an inclusive 1-based round range from a message list, for reading a
 * search hit back in full.
 *
 * Returns only the rounds that exist; an out-of-range request yields an empty
 * array rather than throwing, since the model picks the numbers from a hit list
 * that may have gone stale.
 */
export function readHistoryRounds(messages: ChatHistoryItem[], roundFrom: number, roundTo: number): HistoryRound[] {
  const { rounds } = splitRounds(messages)
  const from = Math.max(1, roundFrom)
  const to = Math.min(rounds.length, roundTo)

  const selected: HistoryRound[] = []
  for (let round = from; round <= to; round++) {
    selected.push({
      round,
      messages: rounds[round - 1]
        .filter(message => SEARCHABLE_ROLES.has(message.role))
        .map(message => ({ role: message.role, text: extractMessageText(message), at: message.createdAt })),
    })
  }
  return selected
}

/**
 * The same projection as {@link readHistoryRounds} for an archived row, whose
 * rounds are numbered from `roundFrom` rather than from 1.
 */
export function readArchivedRounds(archive: ArchivedSummaryRow): HistoryRound[] {
  const archived = asChatHistoryItems(archive.rawMessages)
  const { rounds } = splitRounds(archived)
  return rounds.map((round, offset) => ({
    round: (archive.roundFrom ?? 1) + offset,
    messages: round
      .filter(message => SEARCHABLE_ROLES.has(message.role))
      .map(message => ({ role: message.role, text: extractMessageText(message), at: message.createdAt })),
  }))
}
