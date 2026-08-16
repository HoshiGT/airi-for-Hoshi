import type { Message } from '@xsai/shared-chat'

import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { trimConversationHistory } from './brain'

/**
 * These tests guard the prompt cache, not the trimming arithmetic.
 *
 * `claude-code-brain` (`services/claude-code-brain/src/sessions.ts`) keys sessions off the user
 * message sequence alone:
 *
 *   - after answering request N it stores the session under `hash(all user turns in N)`
 *   - when request N+1 arrives it looks up `hash(all user turns in N+1, except the newest)`
 *
 * Those two are equal exactly when request N+1 is request N plus one new user turn — and then the
 * backend resumes the SDK session, so the shared prefix is a cache read (0.1x). Trimming breaks the
 * equality, because the head of the sequence moves: the lookup misses and the whole conversation is
 * replayed as a cache create (1.25x).
 *
 * Dropping two messages per turn therefore missed on EVERY turn, permanently, from the moment
 * history first reached the cap. Batching turns that into one miss per batch.
 */

function userTexts(history: Message[]): string[] {
  return history
    .filter(message => message.role === 'user')
    .map(message => String(message.content))
}

function hashTexts(texts: string[]): string {
  return createHash('sha256').update(texts.join('\u0000')).digest('hex')
}

/** What the backend stores after answering this request. */
function sessionStoreKey(history: Message[]): string {
  return hashTexts(userTexts(history))
}

/** What the backend looks up when this request arrives. Undefined means "start fresh". */
function sessionLookupKey(history: Message[]): string | undefined {
  const users = userTexts(history)
  if (users.length < 2)
    return undefined
  return hashTexts(users.slice(0, -1))
}

/** One turn: append the user message, then the assistant reply, then trim. */
function takeTurn(history: Message[], n: number): Message[] {
  const next = [
    ...history,
    { role: 'user', content: `user-${n}` } as Message,
    { role: 'assistant', content: `assistant-${n}` } as Message,
  ]
  return trimConversationHistory(next)
}

/**
 * Replay `turns` turns and count how many of them the backend could resume.
 *
 * `trim` is injectable so the current strategy can be compared against the old one on identical
 * input — a bare hit count means little without the baseline it is supposed to beat.
 */
function countCacheHits(turns: number, trim: (history: Message[]) => Message[]): { hits: number, total: number } {
  let history: Message[] = []
  let storedKey: string | undefined
  let hits = 0
  let total = 0

  for (let turn = 0; turn < turns; turn++) {
    // The request the bot is about to send: history so far plus the new user turn.
    const request = [...history, { role: 'user', content: `user-${turn}` } as Message]

    const lookupKey = sessionLookupKey(request)
    if (lookupKey !== undefined) {
      total++
      if (storedKey !== undefined && lookupKey === storedKey)
        hits++
    }

    storedKey = sessionStoreKey(request)

    history = trim([...request, { role: 'assistant', content: `assistant-${turn}` } as Message])
  }

  return { hits, total }
}

/** The behaviour before this change: shave off just enough to sit exactly at the cap. */
function trimTwoPerTurn(history: Message[]): Message[] {
  if (history.length <= 200)
    return history
  return history.slice(history.length - 200)
}

describe('trimConversationHistory', () => {
  it('leaves short histories untouched', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `m${i}` })) as Message[]
    expect(trimConversationHistory(history)).toBe(history)
  })

  it('keeps history bounded', () => {
    let history: Message[] = []
    for (let turn = 0; turn < 500; turn++)
      history = takeTurn(history, turn)

    expect(history.length).toBeLessThanOrEqual(200)
    // Batched trimming makes the length oscillate rather than sit exactly at the cap.
    expect(history.length).toBeGreaterThan(150)
  })

  it('drops from the front, keeping the most recent exchanges', () => {
    let history: Message[] = []
    for (let turn = 0; turn < 300; turn++)
      history = takeTurn(history, turn)

    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'assistant-299' })
    expect(history.at(-2)).toEqual({ role: 'user', content: 'user-299' })
    expect(history.find(message => message.content === 'user-0')).toBeUndefined()
  })

  it('never trims below the cap even when handed a huge history at once', () => {
    const huge = Array.from({ length: 1000 }, (_, i) => ({ role: 'user', content: `m${i}` })) as Message[]
    const trimmed = trimConversationHistory(huge)

    expect(trimmed.length).toBe(200)
    expect(trimmed[0]).toEqual({ role: 'user', content: 'm800' })
  })

  // The regression this whole change exists to prevent.
  it('lets the backend resume on the overwhelming majority of turns', () => {
    const { hits, total } = countCacheHits(300, trimConversationHistory)

    // One miss per 40-message batch, i.e. per 20 turns.
    expect(hits / total).toBeGreaterThan(0.9)
  })

  it('beats the old two-per-turn trim, which missed on every turn past the cap', () => {
    const batched = countCacheHits(300, trimConversationHistory)
    const perTurn = countCacheHits(300, trimTwoPerTurn)

    // Before the cap both strategies are no-ops and hit every turn; after it, the old one misses
    // every single turn while the batched one misses once per batch.
    expect(perTurn.hits).toBeLessThan(batched.hits)
    expect(batched.hits - perTurn.hits).toBeGreaterThan(90)
  })
})
