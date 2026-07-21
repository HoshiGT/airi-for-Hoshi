import type { OpenAIChatMessage } from './translate'

import { describe, expect, it } from 'vitest'

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

  it('forces fresh on a tool-result continuation even if a session exists', () => {
    const registry = new SessionRegistry()
    const turnN = [user('u1'), assistant('a1'), user('u2')]
    registry.remember(sessionStoreKey(turnN), 'sess-1')

    // Current round carries a tool result → the prior tool-call turn's session
    // was invalidated, so full history must be replayed.
    const toolContinuation: OpenAIChatMessage[] = [
      ...turnN,
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
})
