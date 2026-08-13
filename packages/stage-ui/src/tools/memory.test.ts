import type { Tool } from '@xsai/shared-chat'

import type { RankedMemory } from '../stores/chat/memory/repository'
import type { MemoryItemRow } from '../stores/chat/memory/schema'
import type { MemoryToolsService } from './memory'

import { describe, expect, it, vi } from 'vitest'

import { createMemoryTools } from './memory'

/**
 * Minimal shape of a built tool as this suite reads it: `rawTool` nests the
 * provider-visible name and schema under `function`, while `execute` stays at the
 * top level.
 */
interface BuiltTool {
  function: {
    name: string
    parameters: {
      required?: string[]
      properties?: Record<string, { type?: unknown }>
    }
  }
}

function toolName(tool: Tool): string {
  return (tool as Tool & BuiltTool).function.name
}

function toolParameters(tool: Tool): BuiltTool['function']['parameters'] {
  return (tool as Tool & BuiltTool).function.parameters
}

const ctx = { messages: [], toolCallId: 'test' }

function memoryRow(partial: Partial<MemoryItemRow> = {}): MemoryItemRow {
  return {
    id: 'mem-1',
    characterId: 'airi',
    sessionId: 'session-1',
    kind: 'long',
    content: 'Hoshi prefers concise replies.',
    importance: 0.8,
    keywords: ['hoshi', 'preference'],
    sourceRoundFrom: null,
    sourceRoundTo: null,
    createdAt: new Date(0),
    lastAccessedAt: null,
    accessCount: 0,
    ...partial,
  }
}

function ranked(item: MemoryItemRow, score = 1): RankedMemory {
  return { item, score }
}

function createService() {
  return {
    addMemory: vi.fn<MemoryToolsService['addMemory']>().mockResolvedValue(undefined),
    recall: vi.fn<MemoryToolsService['recall']>().mockResolvedValue([]),
    removeMemory: vi.fn<MemoryToolsService['removeMemory']>().mockResolvedValue(undefined),
  }
}

async function mountTools(service: MemoryToolsService, ids?: { characterId?: string, sessionId?: string }) {
  const tools = await createMemoryTools({
    service,
    getCharacterId: () => ids?.characterId ?? 'airi',
    getSessionId: () => ids?.sessionId ?? 'session-1',
  })

  const byName = new Map(tools.map(tool => [toolName(tool), tool]))
  return {
    tools,
    save: byName.get('memory_save')!,
    recall: byName.get('memory_recall')!,
    forget: byName.get('memory_forget')!,
  }
}

describe('createMemoryTools', () => {
  it('mounts save, recall and forget under their model-facing names', async () => {
    const { tools } = await mountTools(createService())
    expect(tools.map(toolName)).toEqual(['memory_save', 'memory_recall', 'memory_forget'])
  })

  it('marks every optional input as required-nullable so strict providers accept the schema', async () => {
    const { save, recall } = await mountTools(createService())

    const saveSchema = toolParameters(save)
    expect(saveSchema.required).toEqual(['content', 'kind', 'importance', 'keywords'])
    // The nullable scalars must ship as `type: [..., 'null']`, not as an anyOf.
    expect(saveSchema.properties?.importance.type).toEqual(['number', 'null'])

    const recallSchema = toolParameters(recall)
    expect(recallSchema.required).toEqual(['query', 'limit'])
    expect(recallSchema.properties?.limit.type).toEqual(['integer', 'null'])
  })

  describe('memory_save', () => {
    it('writes the memory against the current character and session', async () => {
      const service = createService()
      const { save } = await mountTools(service, { characterId: 'char-42', sessionId: 'qq-private-9' })

      const result = await save.execute({
        content: '  Hoshi dislikes emoji in replies.  ',
        kind: 'short',
        importance: 0.9,
        keywords: ['hoshi', 'emoji'],
      }, ctx) as string

      expect(service.addMemory).toHaveBeenCalledWith({
        characterId: 'char-42',
        sessionId: 'qq-private-9',
        content: 'Hoshi dislikes emoji in replies.',
        kind: 'short',
        importance: 0.9,
        keywords: ['hoshi', 'emoji'],
      })
      expect(result).toContain('Hoshi dislikes emoji in replies.')
    })

    it('falls back to a neutral long-term memory when the model omits the optional fields', async () => {
      const service = createService()
      const { save } = await mountTools(service)

      await save.execute({ content: 'Airi likes rainy afternoons.', kind: null, importance: null, keywords: null }, ctx)

      expect(service.addMemory).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'long',
        importance: 0.5,
        keywords: [],
      }))
    })

    it('coerces an unrecognized kind into a long-term memory', async () => {
      // ROOT CAUSE:
      //
      // normalizeNullableAnyOf collapses `enum(['long','short']) | null` into
      // `type: ['string', 'null']`, dropping the enum, so nothing stops a model
      // from sending "medium". `kind` is a plain text column, so the row would
      // persist and then match neither the long nor the short filter.
      const service = createService()
      const { save } = await mountTools(service)

      await save.execute({ content: 'Something in between.', kind: 'medium', importance: null, keywords: null }, ctx)

      expect(service.addMemory).toHaveBeenCalledWith(expect.objectContaining({ kind: 'long' }))
    })

    it('clamps importance into 0..1 because the schema bound does not survive normalization', async () => {
      const service = createService()
      const { save } = await mountTools(service)

      await save.execute({ content: 'Never forget this.', kind: null, importance: 7, keywords: null }, ctx)
      await save.execute({ content: 'Barely matters.', kind: null, importance: -3, keywords: null }, ctx)

      expect(service.addMemory).toHaveBeenNthCalledWith(1, expect.objectContaining({ importance: 1 }))
      expect(service.addMemory).toHaveBeenNthCalledWith(2, expect.objectContaining({ importance: 0 }))
    })
  })

  describe('memory_recall', () => {
    it('renders matches with kind, importance and tags, scoped to the character only', async () => {
      const service = createService()
      service.recall.mockResolvedValue([
        ranked(memoryRow()),
        ranked(memoryRow({ id: 'mem-2', kind: 'short', importance: 0.4, content: 'Working on the memory tools today.', keywords: [] })),
      ])
      const { recall } = await mountTools(service, { characterId: 'airi', sessionId: 'session-1' })

      const result = await recall.execute({ query: 'hoshi preference', limit: null }, ctx) as string

      // No sessionId in the options: reaching conversations other than this one is
      // the entire point of recall.
      expect(service.recall).toHaveBeenCalledWith('hoshi preference', { characterId: 'airi', limit: 6 })
      expect(result).toContain('2 stored memories matched "hoshi preference"')
      expect(result).toContain('- [long-term, importance 0.80] Hoshi prefers concise replies. (tags: hoshi, preference)')
      expect(result).toContain('- [short-term, importance 0.40] Working on the memory tools today.')
    })

    it('clamps the requested limit into 1..20', async () => {
      const service = createService()
      const { recall } = await mountTools(service)

      await recall.execute({ query: 'anything', limit: 999 }, ctx)
      await recall.execute({ query: 'anything', limit: 0 }, ctx)

      expect(service.recall).toHaveBeenNthCalledWith(1, 'anything', expect.objectContaining({ limit: 20 }))
      expect(service.recall).toHaveBeenNthCalledWith(2, 'anything', expect.objectContaining({ limit: 1 }))
    })

    it('says so plainly when nothing matched', async () => {
      const { recall } = await mountTools(createService())
      const result = await recall.execute({ query: 'unknown topic', limit: null }, ctx) as string
      expect(result).toBe('No stored memories matched "unknown topic".')
    })
  })

  describe('memory_forget', () => {
    it('deletes the single best match and echoes what it removed', async () => {
      const service = createService()
      service.recall.mockResolvedValue([ranked(memoryRow({ id: 'mem-7', content: 'Hoshi lives in Tokyo.' }))])
      const { forget } = await mountTools(service)

      const result = await forget.execute({ query: 'hoshi tokyo' }, ctx) as string

      // limit 1: the model passes wording rather than an id, so only the top hit
      // is ever at risk.
      expect(service.recall).toHaveBeenCalledWith('hoshi tokyo', { characterId: 'airi', limit: 1 })
      expect(service.removeMemory).toHaveBeenCalledWith('mem-7')
      expect(result).toBe('Deleted this memory: "Hoshi lives in Tokyo."')
    })

    it('deletes nothing when no memory matched', async () => {
      const service = createService()
      const { forget } = await mountTools(service)

      const result = await forget.execute({ query: 'never stored' }, ctx) as string

      expect(service.removeMemory).not.toHaveBeenCalled()
      expect(result).toContain('nothing was deleted')
    })
  })
})
