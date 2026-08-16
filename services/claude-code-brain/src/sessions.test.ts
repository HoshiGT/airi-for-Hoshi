import type { OpenAIChatMessage } from './translate'

import { describe, expect, it, vi } from 'vitest'

import { decideStrategy, sessionLookupKey, SessionRegistry, sessionStoreKey } from './sessions'

function user(text: string): OpenAIChatMessage {
  return { role: 'user', content: text }
}
function assistant(text: string): OpenAIChatMessage {
  return { role: 'assistant', content: text }
}
function system(text: string): OpenAIChatMessage {
  return { role: 'system', content: text }
}

describe('session fingerprints', () => {
  it('the store key of turn N equals the lookup key of turn N+1', () => {
    // Turn N ended after the assistant replied to u2; turn N+1 adds u3.
    const turnN = [system('card'), user('u1'), assistant('a1'), user('u2')]
    const turnNext = [...turnN, assistant('a2'), user('u3')]

    expect(sessionStoreKey(turnN)).toBe(sessionLookupKey(turnNext))
  })

  it('ignores assistant reply text so marker/reasoning stripping does not drift the key', () => {
    // Same user turns, different assistant replies (AIRI strips stickers/ACT
    // markers and reasoning before replaying) → identical lookup key.
    const withMarkers = [user('hi'), assistant('hey <|STICKER_wave|>'), user('how are you')]
    const stripped = [user('hi'), assistant('hey'), user('how are you')]

    expect(sessionLookupKey(withMarkers)).toBe(sessionLookupKey(stripped))
  })

  it('has no lookup key for the very first turn (no prior user turn)', () => {
    expect(sessionLookupKey([system('card'), user('first')])).toBeUndefined()
  })

  it('separates turns so appended text cannot collide with a longer single turn', () => {
    // ["a", "b"] must not hash the same as ["a b"].
    expect(sessionStoreKey([user('a'), assistant('x'), user('b')]))
      .not
      .toBe(sessionStoreKey([user('a b')]))
  })

  it('survives AIRI sliding-window history (old messages dropped from front)', () => {
    // AIRI sends a fixed-size sliding window (~10 user messages). Each turn,
    // the oldest user message drops off and a new one is added. The fingerprint
    // must still match across the shift.
    const window10 = Array.from({ length: 10 }, (_, i) => {
      const msgs: OpenAIChatMessage[] = []
      msgs.push(user(`[2026-08-10 13:${String(i).padStart(2, '0')}] msg${i}`))
      if (i < 9)
        msgs.push(assistant(`reply${i}`))
      return msgs
    }).flat()

    // Turn N: window is [msg0..msg9], msg9 is the newest user message.
    const storeKeyN = sessionStoreKey(window10)

    // Turn N+1: msg0 dropped, msg10 added. Same sliding-window effect.
    const window10shifted = [
      ...window10.slice(2), // drop msg0 + reply0
      assistant('reply9'),
      user('[2026-08-10 13:10] msg10'),
    ]

    const lookupKeyN1 = sessionLookupKey(window10shifted)
    expect(storeKeyN).toBe(lookupKeyN1)
  })

  it('still matches after multiple consecutive window shifts', () => {
    // Turn N: users [m0, m1, m2, m3, m4, m5]
    const tN: OpenAIChatMessage[] = [
      user('m0'),
      assistant('r0'),
      user('m1'),
      assistant('r1'),
      user('m2'),
      assistant('r2'),
      user('m3'),
      assistant('r3'),
      user('m4'),
      assistant('r4'),
      user('m5'),
    ]
    const sk0 = sessionStoreKey(tN)

    // Turn N+1: users [m1, m2, m3, m4, m5, m6] — m0 dropped
    const tN1: OpenAIChatMessage[] = [
      user('m1'),
      assistant('r1'),
      user('m2'),
      assistant('r2'),
      user('m3'),
      assistant('r3'),
      user('m4'),
      assistant('r4'),
      user('m5'),
      assistant('r5'),
      user('m6'),
    ]
    expect(sessionLookupKey(tN1)).toBe(sk0)

    const sk1 = sessionStoreKey(tN1)

    // Turn N+2: users [m2, m3, m4, m5, m6, m7] — m1 dropped
    const tN2: OpenAIChatMessage[] = [
      user('m2'),
      assistant('r2'),
      user('m3'),
      assistant('r3'),
      user('m4'),
      assistant('r4'),
      user('m5'),
      assistant('r5'),
      user('m6'),
      assistant('r6'),
      user('m7'),
    ]
    expect(sessionLookupKey(tN2)).toBe(sk1)
  })
})

describe('decideStrategy', () => {
  it('starts fresh when no session is registered', () => {
    const registry = new SessionRegistry()
    const messages = [user('u1'), assistant('a1'), user('u2')]

    expect(decideStrategy(messages, registry)).toEqual({ mode: 'fresh' })
  })

  it('resumes once the prior turn registered a session', () => {
    const registry = new SessionRegistry()
    const turnN = [user('u1'), assistant('a1'), user('u2')]
    registry.remember(sessionStoreKey(turnN), 'sess-1')

    const turnNext = [...turnN, assistant('a2'), user('u3')]
    expect(decideStrategy(turnNext, registry)).toEqual({
      mode: 'resume',
      sessionId: 'sess-1',
      lookupKey: sessionLookupKey(turnNext),
    })
  })

  it('resumes a tool-result continuation using storeKey when a session exists', () => {
    const registry = new SessionRegistry()
    // The tool-call turn stored its session under storeKey (all user messages).
    const turnN = [user('u1'), assistant('a1'), user('u2')]
    registry.remember(sessionStoreKey(turnN), 'sess-tool')

    // Tool-result continuation: same user messages, no new user message added.
    // The storeKey of the tool-call turn = storeKey of this request (same user
    // messages), so the lookup finds the session.
    const toolContinuation: OpenAIChatMessage[] = [
      ...turnN,
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_time', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'get_time', content: '12:00' },
    ]
    const result = decideStrategy(toolContinuation, registry)
    expect(result.mode).toBe('resume')
    expect(result).toEqual({
      mode: 'resume',
      sessionId: 'sess-tool',
      lookupKey: sessionStoreKey(turnN),
    })
  })

  it('falls back to fresh on a tool-result continuation when no session exists', () => {
    const registry = new SessionRegistry()
    const toolContinuation: OpenAIChatMessage[] = [
      user('u1'),
      assistant('a1'),
      user('u2'),
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_time', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'get_time', content: '12:00' },
    ]
    expect(decideStrategy(toolContinuation, registry).mode).toBe('fresh')
  })
})

describe('sessionRegistry', () => {
  it('remembers and looks up a session', () => {
    const registry = new SessionRegistry()
    registry.remember('k', 'sess-1')
    expect(registry.lookup('k')).toBe('sess-1')
  })

  it('invalidate drops the entry', () => {
    const registry = new SessionRegistry()
    registry.remember('k', 'sess-1')
    registry.invalidate('k')
    expect(registry.lookup('k')).toBeUndefined()
  })

  it('treats entries past the TTL as gone', () => {
    // A negative TTL makes any elapsed time (>= 0) exceed it, so the entry reads
    // as expired deterministically without mocking the clock.
    const registry = new SessionRegistry(200, -1)
    registry.remember('k', 'sess-1')
    expect(registry.lookup('k')).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  it('evicts the least-recently-used entry past the cap', () => {
    const registry = new SessionRegistry(2)
    registry.remember('a', 'sa')
    registry.remember('b', 'sb')
    registry.lookup('a') // 'a' is now more recently used than 'b'
    registry.remember('c', 'sc') // over cap → evict LRU, which is 'b'

    expect(registry.lookup('b')).toBeUndefined()
    expect(registry.lookup('a')).toBe('sa')
    expect(registry.lookup('c')).toBe('sc')
  })

  it('fires onEvict on TTL expiry', () => {
    const onEvict = vi.fn()
    const registry = new SessionRegistry(200, -1, onEvict)
    registry.remember('k', 'sess-expired')
    registry.lookup('k')
    expect(onEvict).toHaveBeenCalledWith('sess-expired')
  })

  it('fires onEvict on LRU eviction', () => {
    const onEvict = vi.fn()
    const registry = new SessionRegistry(1, 20 * 60 * 1000, onEvict)
    registry.remember('a', 'sa')
    registry.remember('b', 'sb') // evicts 'a'
    expect(onEvict).toHaveBeenCalledWith('sa')
  })

  it('does NOT fire onEvict on explicit invalidate', () => {
    const onEvict = vi.fn()
    const registry = new SessionRegistry(200, 20 * 60 * 1000, onEvict)
    registry.remember('k', 'sess-1')
    registry.invalidate('k')
    expect(onEvict).not.toHaveBeenCalled()
  })
})
