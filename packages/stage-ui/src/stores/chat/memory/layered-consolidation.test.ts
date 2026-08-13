import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { MemoryDatabase } from './db'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyMemorySchema } from './db'
import { MemoryRepository } from './repository'
import { memorySchema } from './schema'

const generateTextMock = vi.fn()

// The model call is the only external boundary here; storage runs against a
// real in-memory PGlite so the persisted rows and watermarks are asserted for
// real.
vi.mock('@xsai/generate-text', () => ({
  generateText: (options: unknown) => generateTextMock(options),
}))

const { runLayerOnePass, runLayerThreePass, runLayerTwoPass } = await import('./layered-consolidation')

const provider: ChatProvider = {
  chat: model => ({ baseURL: 'http://localhost/', model }),
}

const l1Reply = {
  items: [
    { content: 'user runs a QQ bot', kind: 'long', importance: 0.9, keywords: ['QQ', 'bot'] },
    { content: 'user is testing today', kind: 'short', importance: 0.4, keywords: ['testing'] },
  ],
}

const messages: Message[] = [
  { role: 'user', content: 'help me set up the qq bot' },
  { role: 'assistant', content: 'sure, configure NapCat first' },
]

async function makeRepository(): Promise<MemoryRepository> {
  const db = drizzle(new PGlite(), { schema: memorySchema }) as unknown as MemoryDatabase
  await applyMemorySchema(db)
  return new MemoryRepository(db)
}

async function seedL1Facts(repository: MemoryRepository, count: number): Promise<void> {
  await repository.addMemoryItems(Array.from({ length: count }, (_, i) => ({
    id: `l1-${i}`,
    characterId: 'default',
    sessionId: 's1',
    kind: 'long',
    layer: 1,
    content: `fact ${i}`,
    importance: 0.5,
    keywords: [`kw-${i}`],
  })))
}

function sentSystemPrompt(): string {
  const options = generateTextMock.mock.calls[0][0] as { messages: Message[] }
  const system = options.messages.find(m => m.role === 'system')
  return String(system?.content)
}

beforeEach(() => {
  generateTextMock.mockReset().mockResolvedValue({ text: JSON.stringify(l1Reply) })
})

describe('runLayerOnePass', () => {
  it('writes layer-1 facts with round provenance and leaves no archive behind', async () => {
    const repository = await makeRepository()

    const result = await runLayerOnePass({
      provider,
      model: 'test-model',
      characterId: 'default',
      sessionId: 's1',
      messages,
      roundFrom: 2,
      roundTo: 3,
      repository,
    })

    expect(result.itemCount).toBe(2)

    const items = await repository.listMemoryItems({ sessionId: 's1', layer: 1 })
    expect(items).toHaveLength(2)
    expect(items.map(item => item.sourceRoundFrom)).toEqual([2, 2])
    expect(items.map(item => item.sourceRoundTo)).toEqual([3, 3])
    expect(items.every(item => item.aggregatedAt === null)).toBe(true)

    // Layered passes must stay non-destructive: no archived summary rows.
    expect(await repository.listArchivedSummaries({ sessionId: 's1' })).toHaveLength(0)
  })

  it('mentions already-recorded facts to the model for dedup', async () => {
    const repository = await makeRepository()
    await repository.addMemoryItems([{
      id: 'existing-1',
      characterId: 'default',
      sessionId: 's1',
      kind: 'long',
      layer: 1,
      content: 'user runs a QQ bot',
      importance: 0.9,
      keywords: ['qq', 'bot'],
    }])

    await runLayerOnePass({
      provider,
      model: 'test-model',
      characterId: 'default',
      sessionId: 's1',
      messages,
      roundFrom: 1,
      roundTo: 1,
      repository,
    })

    expect(sentSystemPrompt()).toContain('user runs a QQ bot')
  })
})

describe('runLayerTwoPass', () => {
  beforeEach(() => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        items: [
          { content: 'user spent the week on QQ bot voice', importance: 0.8, keywords: ['qq', 'bot'] },
        ],
      }),
    })
  })

  it('aggregates pending L1 facts into a scene and stamps the sources', async () => {
    const repository = await makeRepository()
    await seedL1Facts(repository, 8)

    const result = await runLayerTwoPass({
      provider,
      model: 'test-model',
      characterId: 'default',
      sessionId: 's1',
      repository,
    })

    expect(result.itemCount).toBe(1)

    const scenes = await repository.listMemoryItems({ sessionId: 's1', layer: 2 })
    expect(scenes).toHaveLength(1)
    expect(scenes[0]?.content).toBe('user spent the week on QQ bot voice')
    expect(scenes[0]?.kind).toBe('long')

    // Consumed sources carry the aggregation watermark; new L1 facts stay open.
    expect(await repository.countPendingLayerItems(1, { characterId: 'default', sessionId: 's1' })).toBe(0)
    await repository.addMemoryItems([{
      id: 'l1-fresh',
      characterId: 'default',
      sessionId: 's1',
      kind: 'long',
      layer: 1,
      content: 'brand new fact',
      importance: 0.5,
      keywords: ['new'],
    }])
    expect(await repository.countPendingLayerItems(1, { characterId: 'default', sessionId: 's1' })).toBe(1)
  })

  it('stamps the batch even when the model returns no scenes, so it is not re-submitted every turn', async () => {
    const repository = await makeRepository()
    await seedL1Facts(repository, 8)
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ items: [] }) })

    const result = await runLayerTwoPass({
      provider,
      model: 'test-model',
      characterId: 'default',
      sessionId: 's1',
      repository,
    })

    expect(result.itemCount).toBe(0)
    expect(await repository.countPendingLayerItems(1, { characterId: 'default', sessionId: 's1' })).toBe(0)
  })
})

describe('runLayerThreePass', () => {
  it('aggregates pending L2 scenes across sessions into a global profile', async () => {
    const repository = await makeRepository()
    await repository.addMemoryItems([
      {
        id: 'l2-a',
        characterId: 'default',
        sessionId: 's1',
        kind: 'long',
        layer: 2,
        content: 'scene from session one',
        importance: 0.6,
        keywords: ['scene'],
      },
      {
        id: 'l2-b',
        characterId: 'default',
        sessionId: 's2',
        kind: 'long',
        layer: 2,
        content: 'scene from session two',
        importance: 0.7,
        keywords: ['scene'],
      },
    ])
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        items: [
          { content: 'user keeps long-running side projects', importance: 0.9, keywords: ['projects'] },
        ],
      }),
    })

    const result = await runLayerThreePass({
      provider,
      model: 'test-model',
      characterId: 'default',
      sessionId: 's2',
      repository,
    })

    expect(result.itemCount).toBe(1)

    const profile = await repository.listMemoryItems({ characterId: 'default', layer: 3 })
    expect(profile).toHaveLength(1)
    // Profile facts are character-scoped, so they survive per-session clears.
    expect(profile[0]?.sessionId).toBe('global')

    expect(await repository.countPendingLayerItems(2, { characterId: 'default' })).toBe(0)
  })
})

describe('layer state repository', () => {
  it('upserts and reads the (character, session) schedule row', async () => {
    const repository = await makeRepository()

    expect(await repository.getLayerState('default', 's1')).toBeUndefined()

    await repository.upsertLayerState({
      characterId: 'default',
      sessionId: 's1',
      warmupStep: 1,
      l1RoundsProcessed: 3,
      l1PassCount: 1,
    })
    await repository.upsertLayerState({
      characterId: 'default',
      sessionId: 's1',
      warmupStep: 2,
      l1RoundsProcessed: 5,
      l1PassCount: 2,
    })

    const state = await repository.getLayerState('default', 's1')
    expect(state?.warmupStep).toBe(2)
    expect(state?.l1RoundsProcessed).toBe(5)
    expect(state?.l1PassCount).toBe(2)

    // A different session keeps its own row.
    expect(await repository.getLayerState('default', 's2')).toBeUndefined()
  })
})
