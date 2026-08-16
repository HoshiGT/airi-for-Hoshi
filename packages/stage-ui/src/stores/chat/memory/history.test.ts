import type { ChatHistoryItem } from '../../../types/chat'
import type { HistorySessionSource } from './history'
import type { ArchivedSummaryRow } from './schema'

import { describe, expect, it } from 'vitest'

import { readArchivedRounds, readHistoryRounds, searchHistory } from './history'

function user(text: string, partial: Partial<ChatHistoryItem> = {}): ChatHistoryItem {
  return { role: 'user', content: text, ...partial } as ChatHistoryItem
}

function assistant(text: string, partial: Partial<ChatHistoryItem> = {}): ChatHistoryItem {
  return { role: 'assistant', content: text, slices: [], tool_results: [], ...partial } as ChatHistoryItem
}

function session(partial: Partial<HistorySessionSource> = {}): HistorySessionSource {
  return {
    sessionId: 'session-1',
    title: 'Android 折腾',
    updatedAt: 1000,
    messages: [],
    ...partial,
  }
}

function archive(partial: Partial<ArchivedSummaryRow> = {}): ArchivedSummaryRow {
  return {
    id: 'archive-1',
    characterId: 'airi',
    sessionId: 'session-old',
    summary: 'Talked about the Android build pipeline.',
    rawMessages: [],
    roundFrom: 1,
    roundTo: 2,
    createdAt: new Date(0),
    ...partial,
  }
}

describe('searchHistory', () => {
  it('finds a message in a session other than the open one and reports where it lives', () => {
    const hits = searchHistory({
      sessions: [
        session({ sessionId: 'session-a', title: 'Today', messages: [user('what should we eat')] }),
        session({
          sessionId: 'session-b',
          title: 'Android 折腾',
          updatedAt: 500,
          messages: [
            { role: 'system', content: 'You are Airi.' } as ChatHistoryItem,
            user('how do we sign the Android build', { createdAt: 700 }),
            assistant('We agreed to use the debug keystore for now.', { createdAt: 800 }),
          ],
        }),
      ],
      archives: [],
    }, 'Android build', 10)

    expect(hits).toHaveLength(1)
    expect(hits[0].sessionId).toBe('session-b')
    expect(hits[0].sessionTitle).toBe('Android 折腾')
    expect(hits[0].role).toBe('user')
    expect(hits[0].round).toBe(1)
    expect(hits[0].at).toBe(700)
    expect(hits[0].snippet).toContain('Android build')
  })

  it('never returns the system preamble, which is regenerated rather than said', () => {
    const hits = searchHistory({
      sessions: [session({ messages: [{ role: 'system', content: 'Never mention the keystore.' } as ChatHistoryItem] })],
      archives: [],
    }, 'keystore', 10)

    expect(hits).toEqual([])
  })

  it('numbers rounds from the first user turn, matching the trim planner', () => {
    const hits = searchHistory({
      sessions: [session({
        messages: [
          { role: 'system', content: 'You are Airi.' } as ChatHistoryItem,
          user('first question'),
          assistant('first answer'),
          user('second question'),
          assistant('the keystore lives in the repo'),
        ],
      })],
      archives: [],
    }, 'keystore', 10)

    expect(hits).toHaveLength(1)
    expect(hits[0].round).toBe(2)
  })

  it('ranks a verbatim phrase above a message that merely shares tokens', () => {
    const hits = searchHistory({
      sessions: [session({
        messages: [
          user('the keystore is somewhere in the debug folder'),
          user('debug keystore'),
        ],
      })],
      archives: [],
    }, 'debug keystore', 10)

    expect(hits.map(hit => hit.snippet)).toEqual([
      'debug keystore',
      'the keystore is somewhere in the debug folder',
    ])
  })

  it('does not report an archived message twice when consolidation left it in the live session', () => {
    // ROOT CAUSE:
    //
    // Consolidation defaults to `trimAfterConsolidation: false`, so an archived
    // round normally still exists verbatim in the live session. Scanning
    // sessions and archives independently surfaced both copies, and the model
    // would read the same exchange twice with two different provenances.
    //
    // Live messages are scanned first and their ids recorded, so the archived
    // copy is skipped and only genuinely trimmed rounds come from the archive.
    const shared = user('the debug keystore is checked in', { id: 'msg-1', createdAt: 100 })

    const hits = searchHistory({
      sessions: [session({ sessionId: 'session-1', messages: [shared] })],
      archives: [archive({ sessionId: 'session-1', summary: 'nothing relevant', rawMessages: [{ ...shared }] })],
    }, 'debug keystore', 10)

    expect(hits).toHaveLength(1)
    expect(hits[0].source).toBe('session')
  })

  it('surfaces a trimmed round that only the archive still holds, numbered from the archive range', () => {
    const hits = searchHistory({
      sessions: [session({ sessionId: 'session-1', messages: [user('unrelated chatter')] })],
      archives: [archive({
        sessionId: 'session-1',
        summary: 'nothing relevant',
        roundFrom: 4,
        roundTo: 5,
        rawMessages: [
          user('round four', { id: 'trimmed-1' }),
          assistant('answer four', { id: 'trimmed-2' }),
          user('the debug keystore decision', { id: 'trimmed-3' }),
        ],
      })],
    }, 'debug keystore', 10)

    expect(hits).toHaveLength(1)
    expect(hits[0].source).toBe('archive')
    expect(hits[0].archiveId).toBe('archive-1')
    expect(hits[0].round).toBe(5)
  })

  it('matches the archive summary itself, so a compacted topic is still reachable', () => {
    const hits = searchHistory({
      sessions: [],
      archives: [archive({ summary: 'They decided to ship the Android build unsigned.' })],
    }, 'Android build', 10)

    expect(hits).toHaveLength(1)
    expect(hits[0].source).toBe('archive-summary')
    expect(hits[0].role).toBe('summary')
    expect(hits[0].archiveId).toBe('archive-1')
  })

  it('requires most of the query to be present, so a CJK query does not match every message', () => {
    // The tokenizer emits one token per Han character; without the ratio gate,
    // "上次聊 Android" would match anything containing 上, 次 or 聊 alone.
    const hits = searchHistory({
      sessions: [session({
        messages: [
          user('上班好累'),
          user('上次聊的 Android 方案还算数吗'),
        ],
      })],
      archives: [],
    }, '上次聊 Android', 10)

    expect(hits).toHaveLength(1)
    expect(hits[0].snippet).toContain('上次聊的 Android')
  })

  it('returns nothing for a query with no searchable tokens', () => {
    const hits = searchHistory({
      sessions: [session({ messages: [user('anything at all')] })],
      archives: [],
    }, '???', 10)

    expect(hits).toEqual([])
  })

  it('applies the limit after ranking, so a weaker match never displaces a stronger one', () => {
    const hits = searchHistory({
      sessions: [session({
        messages: [
          // Ranks last despite coming first: it holds both query tokens but
          // never the phrase, so it misses the verbatim bonus.
          user('the keystore sits behind a debug switch'),
          user('debug keystore, as agreed'),
          user('use the debug keystore'),
        ],
      })],
      archives: [],
    }, 'debug keystore', 2)

    expect(hits).toHaveLength(2)
    expect(hits.every(hit => hit.snippet.includes('debug keystore'))).toBe(true)
  })

  it('elides a long message around the match instead of returning the whole wall of text', () => {
    const hits = searchHistory({
      sessions: [session({ messages: [user(`${'x'.repeat(300)} keystore ${'y'.repeat(300)}`)] })],
      archives: [],
    }, 'keystore', 10)

    expect(hits[0].snippet.startsWith('…')).toBe(true)
    expect(hits[0].snippet.endsWith('…')).toBe(true)
    expect(hits[0].snippet).toContain('keystore')
    expect(hits[0].snippet.length).toBeLessThan(200)
  })

  it('ignores archived entries that are not chat messages rather than throwing', () => {
    const hits = searchHistory({
      sessions: [],
      archives: [archive({ summary: 'nothing relevant', rawMessages: [null, 'keystore', { text: 'keystore' }] })],
    }, 'keystore', 10)

    expect(hits).toEqual([])
  })
})

describe('readHistoryRounds', () => {
  const messages = [
    { role: 'system', content: 'You are Airi.' } as ChatHistoryItem,
    user('first question', { createdAt: 1 }),
    assistant('first answer', { createdAt: 2 }),
    user('second question', { createdAt: 3 }),
    assistant('second answer', { createdAt: 4 }),
  ]

  it('returns the requested inclusive round range with its turns in order', () => {
    expect(readHistoryRounds(messages, 1, 2)).toEqual([
      { round: 1, messages: [{ role: 'user', text: 'first question', at: 1 }, { role: 'assistant', text: 'first answer', at: 2 }] },
      { round: 2, messages: [{ role: 'user', text: 'second question', at: 3 }, { role: 'assistant', text: 'second answer', at: 4 }] },
    ])
  })

  it('clamps a range that runs past the end instead of failing on a stale hit', () => {
    expect(readHistoryRounds(messages, 2, 99).map(round => round.round)).toEqual([2])
  })

  it('returns nothing when the range starts past the conversation', () => {
    expect(readHistoryRounds(messages, 9, 12)).toEqual([])
  })
})

describe('readArchivedRounds', () => {
  it('numbers the archived rounds from the archive range, not from one', () => {
    const rounds = readArchivedRounds(archive({
      roundFrom: 7,
      roundTo: 8,
      rawMessages: [user('archived question'), assistant('archived answer'), user('next archived question')],
    }))

    expect(rounds.map(round => round.round)).toEqual([7, 8])
    expect(rounds[0].messages).toEqual([
      { role: 'user', text: 'archived question', at: undefined },
      { role: 'assistant', text: 'archived answer', at: undefined },
    ])
  })
})
