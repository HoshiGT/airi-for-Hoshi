import type { MemoryDatabase } from './db'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, it } from 'vitest'

import { applyMemorySchema } from './db'
import { LocalKeywordRetriever, MemoryRepository, tokenize } from './repository'
import { memorySchema } from './schema'

// Real in-memory PGlite (no mocks): the storage + retriever stack is exercised
// against an actual Postgres-compatible engine, matching how it runs in-browser.
async function makeRepository(): Promise<MemoryRepository> {
  const db = drizzle(new PGlite(), { schema: memorySchema }) as unknown as MemoryDatabase
  await applyMemorySchema(db)
  return new MemoryRepository(db)
}

describe('tokenize', () => {
  it('lowercases and splits latin words', () => {
    expect(tokenize('Remember Hoshi Settings')).toEqual(['remember', 'hoshi', 'settings'])
  })

  it('splits CJK into per-character tokens', () => {
    expect(tokenize('群 设置')).toEqual(['群', '设', '置'])
  })

  it('returns empty for punctuation-only input', () => {
    expect(tokenize('!!! ...')).toEqual([])
  })
})

describe('memoryRepository', () => {
  let repository: MemoryRepository

  beforeEach(async () => {
    repository = await makeRepository()
  })

  it('persists and lists memory items ordered by importance', async () => {
    await repository.addMemoryItems([
      { id: 'a', sessionId: 's1', kind: 'short', content: 'low', importance: 0.2, keywords: ['x'] },
      { id: 'b', sessionId: 's1', kind: 'long', content: 'high', importance: 0.9, keywords: ['y'] },
    ])

    const items = await repository.listMemoryItems({ sessionId: 's1' })
    expect(items.map(i => i.id)).toEqual(['b', 'a'])
    expect(items[0].importance).toBe(0.9)
  })

  it('filters by kind', async () => {
    await repository.addMemoryItems([
      { id: 'a', sessionId: 's1', kind: 'short', content: 'transient', importance: 0.5, keywords: [] },
      { id: 'b', sessionId: 's1', kind: 'long', content: 'stable', importance: 0.5, keywords: [] },
    ])

    const longs = await repository.listMemoryItems({ kind: 'long' })
    expect(longs.map(i => i.id)).toEqual(['b'])
  })

  it('records access by bumping count and stamping last access', async () => {
    await repository.addMemoryItems([
      { id: 'a', sessionId: 's1', kind: 'long', content: 'x', importance: 0.5, keywords: [] },
    ])

    await repository.recordAccess(['a'])
    const [item] = await repository.listMemoryItems()
    expect(item.accessCount).toBe(1)
    expect(item.lastAccessedAt).not.toBeNull()
  })

  it('archives a summary with its raw rounds', async () => {
    await repository.addArchivedSummary({
      id: 'arch1',
      sessionId: 's1',
      summary: 'they discussed QQ setup',
      rawMessages: [{ role: 'user', content: 'hi' }],
      roundFrom: 1,
      roundTo: 20,
    })

    const archives = await repository.listArchivedSummaries({ sessionId: 's1' })
    expect(archives).toHaveLength(1)
    expect(archives[0].summary).toBe('they discussed QQ setup')
    expect(archives[0].rawMessages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('reports how far a session has been summarized, per session', async () => {
    // The watermark a non-trimming consolidation pass resumes from. Read from
    // summaries (never pruned) rather than runs (pruned to the undoable few).
    expect(await repository.latestArchivedRound('s1')).toBe(0)

    await repository.addArchivedSummary({ id: 'a1', sessionId: 's1', summary: 'first', rawMessages: [], roundFrom: 1, roundTo: 10 })
    await repository.addArchivedSummary({ id: 'a2', sessionId: 's1', summary: 'second', rawMessages: [], roundFrom: 11, roundTo: 18 })
    await repository.addArchivedSummary({ id: 'b1', sessionId: 's2', summary: 'other session', rawMessages: [], roundFrom: 1, roundTo: 4 })

    expect(await repository.latestArchivedRound('s1')).toBe(18)
    expect(await repository.latestArchivedRound('s2')).toBe(4)
  })

  it('patches a memory in place and leaves an empty patch untouched', async () => {
    await repository.addMemoryItems([
      { id: 'm', sessionId: 's1', kind: 'short', content: 'orig', importance: 0.3, keywords: ['orig'] },
    ])

    await repository.updateMemoryItem('m', { content: 'corrected', kind: 'long', importance: 0.9, keywords: ['corrected'] })
    const [after] = await repository.listMemoryItems()
    expect(after.content).toBe('corrected')
    expect(after.kind).toBe('long')
    expect(after.importance).toBe(0.9)
    expect(after.keywords).toEqual(['corrected'])

    // Empty patch is a no-op (drizzle rejects `.set({})`), so the row is unchanged.
    await repository.updateMemoryItem('m', {})
    const [unchanged] = await repository.listMemoryItems()
    expect(unchanged.content).toBe('corrected')
  })

  it('removes memory items and archived summaries by id', async () => {
    await repository.addMemoryItems([
      { id: 'keep', sessionId: 's1', kind: 'long', content: 'stays', importance: 0.5, keywords: [] },
      { id: 'gone', sessionId: 's1', kind: 'long', content: 'goes', importance: 0.5, keywords: [] },
    ])
    await repository.addArchivedSummary({ id: 'arch1', sessionId: 's1', summary: 's', rawMessages: [] })

    await repository.removeMemoryItems(['gone'])
    await repository.removeArchivedSummary('arch1')

    expect((await repository.listMemoryItems()).map(i => i.id)).toEqual(['keep'])
    expect(await repository.listArchivedSummaries({ sessionId: 's1' })).toEqual([])
  })
})

describe('memoryRepository · consolidation runs', () => {
  let repository: MemoryRepository

  function run(id: string, sessionId = 's1') {
    return {
      id,
      sessionId,
      archivedMessages: [{ role: 'user', content: id, id: `m-${id}` }],
      memoryIds: [`mem-${id}`],
      archiveId: `arch-${id}`,
      roundFrom: 1,
      roundTo: 3,
    }
  }

  beforeEach(async () => {
    repository = await makeRepository()
  })

  it('returns the newest run for LIFO undo, even within one timestamp tick', async () => {
    await repository.addConsolidationRun(run('r1'))
    await repository.addConsolidationRun(run('r2'))

    const latest = await repository.latestConsolidationRun('s1')
    expect(latest?.id).toBe('r2')
    expect(latest?.archivedMessages).toEqual([{ role: 'user', content: 'r2', id: 'm-r2' }])
    expect(latest?.memoryIds).toEqual(['mem-r2'])
    expect(latest?.archiveId).toBe('arch-r2')
  })

  it('counts runs per session', async () => {
    await repository.addConsolidationRun(run('r1'))
    await repository.addConsolidationRun(run('r2', 'other'))
    expect(await repository.countConsolidationRuns('s1')).toBe(1)
    expect(await repository.countConsolidationRuns('other')).toBe(1)
    expect(await repository.countConsolidationRuns('empty')).toBe(0)
  })

  it('prunes to the most recent runs without touching other sessions', async () => {
    await repository.addConsolidationRun(run('r1'))
    await repository.addConsolidationRun(run('r2'))
    await repository.addConsolidationRun(run('r3'))
    await repository.addConsolidationRun(run('other-run', 'other'))

    await repository.pruneConsolidationRuns('s1', 2)

    expect(await repository.countConsolidationRuns('s1')).toBe(2)
    // r1 (oldest) lost its undo backup; r3 stays the newest.
    expect((await repository.latestConsolidationRun('s1'))?.id).toBe('r3')
    expect(await repository.countConsolidationRuns('other')).toBe(1)
  })

  it('deletes a single run by id', async () => {
    await repository.addConsolidationRun(run('r1'))
    await repository.addConsolidationRun(run('r2'))

    await repository.deleteConsolidationRun('r2')

    // After the newest run is undone, the previous one becomes undoable.
    expect((await repository.latestConsolidationRun('s1'))?.id).toBe('r1')
  })

  it('clear also drops the undo backups', async () => {
    await repository.addConsolidationRun(run('r1'))
    await repository.clear('s1')
    expect(await repository.countConsolidationRuns('s1')).toBe(0)
  })
})

describe('memoryRepository · export / import', () => {
  let source: MemoryRepository

  beforeEach(async () => {
    source = await makeRepository()
    await source.addMemoryItems([
      { id: 'm1', sessionId: 's1', kind: 'long', content: 'user runs a QQ bot', importance: 0.8, keywords: ['qq'] },
      { id: 'm2', sessionId: 's2', kind: 'short', content: 'debugging tray icon', importance: 0.3, keywords: ['tray'] },
    ])
    await source.recordAccess(['m1'])
    await source.addArchivedSummary({
      id: 'arch1',
      sessionId: 's1',
      summary: 'they set up the QQ bot',
      rawMessages: [{ role: 'user', content: 'hi' }],
      roundFrom: 1,
      roundTo: 20,
    })
    await source.addConsolidationRun({
      id: 'r1',
      sessionId: 's1',
      archivedMessages: [{ role: 'user', content: 'old-1', id: 'msg-1' }],
      memoryIds: ['m1'],
      archiveId: 'arch1',
    })
    await source.addConsolidationRun({
      id: 'r2',
      sessionId: 's1',
      archivedMessages: [{ role: 'user', content: 'old-2', id: 'msg-2' }],
      memoryIds: ['m2'],
      archiveId: 'arch1',
    })
  })

  // Simulates the actual backup file: the payload passes through
  // JSON.stringify/parse, so Date fields must survive as ISO strings and be
  // revived on import.
  async function roundTripInto(target: MemoryRepository) {
    const payload = JSON.parse(JSON.stringify(await source.exportAll()))
    await target.importAll(payload)
  }

  it('round-trips memories, archives, and undo backups into a fresh database', async () => {
    const target = await makeRepository()
    await roundTripInto(target)

    const items = await target.listMemoryItems()
    expect(items.map(i => i.id).sort()).toEqual(['m1', 'm2'])
    const m1 = items.find(i => i.id === 'm1')!
    expect(m1.content).toBe('user runs a QQ bot')
    expect(m1.keywords).toEqual(['qq'])
    expect(m1.accessCount).toBe(1)
    expect(m1.createdAt).toBeInstanceOf(Date)
    expect(m1.lastAccessedAt).toBeInstanceOf(Date)
    const m2 = items.find(i => i.id === 'm2')!
    expect(m2.lastAccessedAt).toBeNull()

    const archives = await target.listArchivedSummaries({ sessionId: 's1' })
    expect(archives).toHaveLength(1)
    expect(archives[0].summary).toBe('they set up the QQ bot')
    expect(archives[0].rawMessages).toEqual([{ role: 'user', content: 'hi' }])

    // LIFO undo order survives the serial re-issue on import.
    expect(await target.countConsolidationRuns('s1')).toBe(2)
    expect((await target.latestConsolidationRun('s1'))?.id).toBe('r2')
  })

  it('imported timestamps equal the exported ones', async () => {
    const target = await makeRepository()
    const [before] = await source.listMemoryItems({ sessionId: 's1' })
    await roundTripInto(target)

    const [after] = await target.listMemoryItems({ sessionId: 's1' })
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime())
    expect(after.lastAccessedAt!.getTime()).toBe(before.lastAccessedAt!.getTime())
  })

  it('re-importing the same backup is a no-op (no duplicates, no overwrites)', async () => {
    const target = await makeRepository()
    await roundTripInto(target)

    // Local divergence after the first import: the user recalled m1 here.
    await target.recordAccess(['m1'])

    await roundTripInto(target)

    const items = await target.listMemoryItems()
    expect(items).toHaveLength(2)
    // The second import must not roll back the locally-bumped access count.
    expect(items.find(i => i.id === 'm1')?.accessCount).toBe(2)
    expect(await target.listArchivedSummaries()).toHaveLength(1)
    expect(await target.countConsolidationRuns('s1')).toBe(2)
  })

  it('importing an empty export leaves the database untouched', async () => {
    const target = await makeRepository()
    const empty = await (await makeRepository()).exportAll()
    expect(empty).toEqual({ memoryItems: [], archivedSummaries: [], consolidationRuns: [], layerStates: [] })

    await target.importAll(empty)
    expect(await target.listMemoryItems()).toEqual([])
  })
})

describe('localKeywordRetriever', () => {
  let repository: MemoryRepository

  beforeEach(async () => {
    repository = await makeRepository()
    await repository.addMemoryItems([
      { id: 'qq', sessionId: 's1', kind: 'long', content: 'user runs a QQ bot', importance: 0.8, keywords: ['qq', 'bot'] },
      { id: 'cat', sessionId: 's1', kind: 'long', content: 'user likes cats', importance: 0.4, keywords: ['cat'] },
    ])
  })

  it('ranks keyword matches and weights by importance', async () => {
    const results = await new LocalKeywordRetriever(repository).search('tell me about the qq bot')
    expect(results).toHaveLength(1)
    expect(results[0].item.id).toBe('qq')
    // overlap 2 (qq, bot) * (0.5 + 0.8 importance) = 2.6
    expect(results[0].score).toBeCloseTo(2.6)
  })

  it('returns empty when nothing overlaps', async () => {
    const results = await new LocalKeywordRetriever(repository).search('weather forecast')
    expect(results).toEqual([])
  })

  it('marks recalled items as accessed', async () => {
    await new LocalKeywordRetriever(repository).search('qq')
    const [hit] = await repository.listMemoryItems({ kind: 'long' })
    // 'qq' item is most important so it sorts first; it was recalled once.
    expect(hit.id).toBe('qq')
    expect(hit.accessCount).toBe(1)
  })
})
