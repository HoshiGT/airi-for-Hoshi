import type { MemoryItemRow } from './schema'

import { describe, expect, it } from 'vitest'

import { formatMemoryDigest } from './digest'

function memory(content: string, importance = 0.5, partial: Partial<MemoryItemRow> = {}): MemoryItemRow {
  return {
    id: `mem-${content.slice(0, 8)}`,
    characterId: 'airi',
    sessionId: 'session-1',
    kind: 'long',
    content,
    importance,
    keywords: [],
    sourceRoundFrom: null,
    sourceRoundTo: null,
    createdAt: new Date(0),
    lastAccessedAt: null,
    accessCount: 0,
    ...partial,
  }
}

describe('formatMemoryDigest', () => {
  it('lists memories with the most important first', () => {
    const digest = formatMemoryDigest([
      memory('Hoshi likes rainy afternoons.', 0.4),
      memory('Hoshi prefers concise replies.', 0.9),
      memory('Hoshi is working on the Android build.', 0.7),
    ])

    const lines = digest.split('\n').filter(line => line.startsWith('- '))
    expect(lines).toEqual([
      '- Hoshi prefers concise replies.',
      '- Hoshi is working on the Android build.',
      '- Hoshi likes rainy afternoons.',
    ])
  })

  it('sorts inside the function rather than trusting the caller', () => {
    // The ordering is part of what the digest means — most important first, and
    // the budget cut is "everything above this line". Depending on the query's
    // ORDER BY would make that silently wrong for any other caller.
    const digest = formatMemoryDigest([memory('low', 0.1), memory('high', 0.99)])

    expect(digest.indexOf('- high')).toBeLessThan(digest.indexOf('- low'))
  })

  it('frames the list as the character own memory, not as a handed-over document', () => {
    const digest = formatMemoryDigest([memory('Hoshi prefers concise replies.', 0.9)])

    expect(digest).toContain('your own memories')
    // And points at the tools, so the visible list is not read as the limit of
    // what it knows.
    expect(digest).toContain('memory_recall')
    expect(digest).toContain('history_search')
  })

  it('returns an empty string when there is nothing worth injecting', () => {
    expect(formatMemoryDigest([])).toBe('')
    expect(formatMemoryDigest([memory('   ', 0.9)])).toBe('')
  })

  it('honours the count limit', () => {
    const items = Array.from({ length: 40 }, (_, i) => memory(`fact number ${i}`, 1 - i / 100))

    const digest = formatMemoryDigest(items, { limit: 5 })

    expect(digest.split('\n').filter(line => line.startsWith('- '))).toHaveLength(5)
  })

  it('stops at the character budget instead of packing in later small entries', () => {
    // Keeping the list in importance order matters more than filling the budget:
    // a digest that skips an important long memory to fit two trivial ones would
    // misrepresent what the character considers significant.
    const digest = formatMemoryDigest([
      memory('a'.repeat(60), 0.9),
      memory('b'.repeat(60), 0.8),
      memory('short one', 0.1),
    ], { maxChars: 70 })

    expect(digest).toContain('a'.repeat(60))
    expect(digest).not.toContain('b'.repeat(60))
    expect(digest).not.toContain('short one')
  })

  it('does not repeat a fact that was saved twice', () => {
    const digest = formatMemoryDigest([
      memory('Hoshi prefers concise replies.', 0.9),
      memory('hoshi prefers concise replies.', 0.6, { id: 'mem-dup' }),
    ])

    expect(digest.split('\n').filter(line => line.startsWith('- '))).toHaveLength(1)
  })

  it('ignores the long/short label, which currently carries no retrieval meaning', () => {
    // `kind` is a settings-page filter today: recall does not pass it and ranking
    // does not weigh it. The digest stays consistent with that instead of
    // inventing a second meaning for the field.
    const digest = formatMemoryDigest([
      memory('short-term but important', 0.9, { kind: 'short' }),
      memory('long-term but trivial', 0.2, { kind: 'long' }),
    ])

    expect(digest.indexOf('short-term but important')).toBeLessThan(digest.indexOf('long-term but trivial'))
  })
})
