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

// AIRI replays a sliding window of recent messages (currently ~10 user turns);
// old messages drop off the front each turn. Hashing ALL user messages would
// drift every turn (the oldest message changes), so we hash only a short tail.
// Must be ≥ 2 for collision resistance and strictly less than the window size
// minus 1 so the tail stays stable across a one-message shift.
const FINGERPRINT_TAIL = 3

/**
 * Fingerprint to *look up* a session for the incoming request: the tail of user
 * turns excluding the newest (the turn we are about to answer). Undefined when
 * there is no prior user turn — nothing to resume, so the caller starts fresh.
 */
export function sessionLookupKey(messages: OpenAIChatMessage[]): string | undefined {
  const users = userMessageTexts(messages)
  if (users.length < 2)
    return undefined
  return hashTexts(users.slice(0, -1).slice(-FINGERPRINT_TAIL))
}

/**
 * Fingerprint to *store* the session after a turn completes: the tail of user
 * turns in the request. The next request's {@link sessionLookupKey} equals
 * this, so the session advances one turn at a time — even when AIRI's sliding
 * window drops old messages from the front.
 */
export function sessionStoreKey(messages: OpenAIChatMessage[]): string {
  return hashTexts(userMessageTexts(messages).slice(-FINGERPRINT_TAIL))
}

function lastAssistantIndex(messages: OpenAIChatMessage[]): number {
  return messages.reduce((last, message, index) => (message.role === 'assistant' ? index : last), -1)
}

/** Whether to resume a cached session (send only the new turn) or start fresh. */
export type SendStrategy
  = | { mode: 'fresh' }
    | { mode: 'resume', sessionId: string, lookupKey: string }

/**
 * Decide resume vs fresh.
 *
 * Tool-result continuations (current round has `role: 'tool'`) try to resume
 * the session stored by the tool-call turn. No new user message is added
 * between the tool-call and tool-result requests, so the lookup key is
 * {@link sessionStoreKey} (hash of ALL user messages), matching what the
 * tool-call turn stored under. If the post-abort session turns out to be
 * incoherent, the error handler in index.ts invalidates it and retries fresh.
 */
export function decideStrategy(messages: OpenAIChatMessage[], registry: SessionRegistry): SendStrategy {
  const currentRound = messages.slice(lastAssistantIndex(messages) + 1)
  const isToolContinuation = currentRound.some(message => message.role === 'tool')

  if (isToolContinuation) {
    // No new user message since the tool-call turn → lookup with storeKey.
    const lookupKey = sessionStoreKey(messages)
    const sessionId = registry.lookup(lookupKey)
    if (sessionId)
      return { mode: 'resume', sessionId, lookupKey }
    return { mode: 'fresh' }
  }

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
  private readonly onEvict?: (sessionId: string) => void

  /**
   * @param maxEntries LRU cap across all conversations.
   * @param ttlMs freshness window; entries older than this are treated as gone.
   * @param onEvict fired with the sessionId when an entry is removed by TTL
   *   expiry or LRU eviction — NOT by explicit `invalidate()`, which is part of
   *   key rotation (the same sessionId is stored under a new key right after).
   */
  constructor(
    private readonly maxEntries = 200,
    private readonly ttlMs = 20 * 60 * 1000,
    onEvict?: (sessionId: string) => void,
  ) {
    this.onEvict = onEvict
  }

  lookup(key: string): string | undefined {
    const entry = this.sessions.get(key)
    if (!entry)
      return undefined
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.sessions.delete(key)
      this.onEvict?.(entry.sessionId)
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
      if (oldestKey !== undefined) {
        const evicted = this.sessions.get(oldestKey)
        this.sessions.delete(oldestKey)
        if (evicted)
          this.onEvict?.(evicted.sessionId)
      }
    }
  }

  invalidate(key: string): void {
    this.sessions.delete(key)
  }

  get size(): number {
    return this.sessions.size
  }
}
