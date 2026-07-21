import type { OpenAIChatMessage } from './translate'

/**
 * Conversation → SDK session mapping for prompt-cache reuse.
 *
 * The brain is otherwise stateless: AIRI resends the full history each request,
 * and today that history is re-flattened into one user turn per fresh `query()`,
 * so the growing transcript is cache-*created* every turn (1.25x) instead of
 * cache-*read* (0.1x). Keeping a live SDK session per conversation and resuming
 * it — sending only the new turn — lets the SDK cache the stable prefix, the way
 * Claude Code stays cheap across a long conversation.
 *
 * Identity is keyed off the *user-message sequence* only, never the model's
 * reply text: AIRI strips markers (stickers/ACT/emote) and reasoning from the
 * assistant turns it replays, so hashing a reply would drift and miss. User
 * turns are replayed verbatim, so they are the stable identity.
 */
import { createHash } from 'node:crypto'

import { textOf } from './translate'

function userMessageTexts(messages: OpenAIChatMessage[]): string[] {
  const texts: string[] = []
  for (const message of messages) {
    if (message.role === 'user')
      texts.push(textOf(message.content))
  }
  return texts
}

// NUL can't appear in chat text, so joining on it can't collide ["a","b"] with
// ["a\u0000b"] — a real separator, not a guessable one.
function hashTexts(texts: string[]): string {
  return createHash('sha256').update(texts.join('\u0000')).digest('hex')
}

/**
 * Fingerprint to *look up* a session for the incoming request: all user turns
 * except the newest (the turn we are about to answer). Undefined when there is
 * no prior user turn — nothing to resume, so the caller starts fresh.
 */
export function sessionLookupKey(messages: OpenAIChatMessage[]): string | undefined {
  const users = userMessageTexts(messages)
  if (users.length < 2)
    return undefined
  return hashTexts(users.slice(0, -1))
}

/**
 * Fingerprint to *store* the session after a turn completes: every user turn in
 * the request. The next request's {@link sessionLookupKey} equals this, so the
 * session advances one turn at a time.
 */
export function sessionStoreKey(messages: OpenAIChatMessage[]): string {
  return hashTexts(userMessageTexts(messages))
}

function lastAssistantIndex(messages: OpenAIChatMessage[]): number {
  return messages.reduce((last, message, index) => (message.role === 'assistant' ? index : last), -1)
}

/** Whether to resume a cached session (send only the new turn) or start fresh. */
export type SendStrategy
  = | { mode: 'fresh' }
    | { mode: 'resume', sessionId: string, lookupKey: string }

/**
 * Decide resume vs fresh. Tool-result continuations always go fresh: the prior
 * tool-call turn aborted its session mid-reply (see the passthrough abort in
 * index.ts), so that conversation's context must be replayed in full.
 */
export function decideStrategy(messages: OpenAIChatMessage[], registry: SessionRegistry): SendStrategy {
  const currentRound = messages.slice(lastAssistantIndex(messages) + 1)
  if (currentRound.some(message => message.role === 'tool'))
    return { mode: 'fresh' }

  const lookupKey = sessionLookupKey(messages)
  if (!lookupKey)
    return { mode: 'fresh' }

  const sessionId = registry.lookup(lookupKey)
  if (!sessionId)
    return { mode: 'fresh' }

  return { mode: 'resume', sessionId, lookupKey }
}

interface SessionEntry {
  sessionId: string
  /** Wall-clock stamp for TTL; refreshed on access to keep active chats alive. */
  storedAt: number
}

/**
 * In-memory conversation→session store. A miss only costs one uncached turn, so
 * this is a bounded best-effort cache: an LRU cap plus a freshness window, so a
 * long-idle session (likely already gone from the SDK's on-disk store) is not
 * resumed into a failure.
 *
 * LRU order is the Map's own insertion order (re-inserting moves a key to the
 * newest position), which is deterministic — timestamps can tie within one
 * millisecond, Map order cannot.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>()

  /**
   * @param maxEntries LRU cap across all conversations.
   * @param ttlMs freshness window; entries older than this are treated as gone.
   */
  constructor(
    private readonly maxEntries = 200,
    private readonly ttlMs = 20 * 60 * 1000,
  ) {}

  lookup(key: string): string | undefined {
    const entry = this.sessions.get(key)
    if (!entry)
      return undefined
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.sessions.delete(key)
      return undefined
    }
    // Refresh recency (move to newest) and TTL.
    this.sessions.delete(key)
    this.sessions.set(key, { sessionId: entry.sessionId, storedAt: Date.now() })
    return entry.sessionId
  }

  remember(key: string, sessionId: string): void {
    // Delete-then-set moves an existing key to the newest position.
    this.sessions.delete(key)
    this.sessions.set(key, { sessionId, storedAt: Date.now() })
    // One insert can exceed the cap by at most one, so evict a single LRU entry
    // — the Map's first key.
    if (this.sessions.size > this.maxEntries) {
      const oldestKey = this.sessions.keys().next().value
      if (oldestKey !== undefined)
        this.sessions.delete(oldestKey)
    }
  }

  invalidate(key: string): void {
    this.sessions.delete(key)
  }

  get size(): number {
    return this.sessions.size
  }
}
