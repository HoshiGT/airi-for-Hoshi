import type { ChatHistoryItem } from '@proj-airi/core-agent'
import type { Tool } from '@xsai/shared-chat'

import type { ArchivedSummaryRow } from '../stores/chat/memory/schema'
import type { HistoryToolsService } from './history'

import { describe, expect, it, vi } from 'vitest'

import { createHistoryTools } from './history'

/**
 * Minimal shape of a built tool as this suite reads it: `rawTool` nests the
 * provider-visible name and schema under `function`, while `execute` stays at
 * the top level.
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

function user(text: string, partial: Partial<ChatHistoryItem> = {}): ChatHistoryItem {
  return { role: 'user', content: text, ...partial } as ChatHistoryItem
}

function assistant(text: string, partial: Partial<ChatHistoryItem> = {}): ChatHistoryItem {
  return { role: 'assistant', content: text, slices: [], tool_results: [], ...partial } as ChatHistoryItem
}

function archive(partial: Partial<ArchivedSummaryRow> = {}): ArchivedSummaryRow {
  return {
    id: 'archive-1',
    characterId: 'airi',
    sessionId: 'session-old',
    summary: 'They settled on the debug keystore.',
    rawMessages: [],
    roundFrom: 1,
    roundTo: 1,
    createdAt: new Date(0),
    ...partial,
  }
}

function createService(overrides: Partial<HistoryToolsService> = {}) {
  return {
    listSessions: vi.fn<HistoryToolsService['listSessions']>().mockResolvedValue([]),
    readSession: vi.fn<HistoryToolsService['readSession']>().mockResolvedValue([]),
    listArchives: vi.fn<HistoryToolsService['listArchives']>().mockResolvedValue([]),
    ...overrides,
  }
}

async function mountTools(service: HistoryToolsService, characterId = 'airi') {
  const tools = await createHistoryTools({ service, getCharacterId: () => characterId })
  const byName = new Map(tools.map(tool => [toolName(tool), tool]))
  return { tools, search: byName.get('history_search')!, read: byName.get('history_read')! }
}

describe('createHistoryTools', () => {
  it('mounts search and read under their model-facing names', async () => {
    const { tools } = await mountTools(createService())
    expect(tools.map(toolName)).toEqual(['history_search', 'history_read'])
  })

  it('marks every optional input as required-nullable so strict providers accept the schema', async () => {
    const { search, read } = await mountTools(createService())

    const searchSchema = toolParameters(search)
    expect(searchSchema.required).toEqual(['query', 'limit'])
    // The nullable scalars must ship as `type: [..., 'null']`, not as an anyOf.
    expect(searchSchema.properties?.limit.type).toEqual(['integer', 'null'])

    const readSchema = toolParameters(read)
    expect(readSchema.required).toEqual(['session_id', 'round_from', 'round_to', 'archive_id'])
    expect(readSchema.properties?.session_id.type).toEqual(['string', 'null'])
    expect(readSchema.properties?.round_from.type).toEqual(['integer', 'null'])
  })

  describe('history_search', () => {
    it('searches every session of the current character and names the session in each hit', async () => {
      const service = createService({
        listSessions: vi.fn<HistoryToolsService['listSessions']>().mockResolvedValue([
          { sessionId: 'session-a', title: 'Today', updatedAt: 2 },
          { sessionId: 'session-b', title: 'Android 折腾', updatedAt: 1 },
        ]),
        readSession: vi.fn<HistoryToolsService['readSession']>().mockImplementation(async sessionId =>
          sessionId === 'session-b' ? [user('we used the debug keystore')] : [user('lunch plans')],
        ),
      })
      const { search } = await mountTools(service, 'char-42')

      const result = await search.execute({ query: 'debug keystore', limit: null }, ctx) as string

      expect(service.listSessions).toHaveBeenCalledWith('char-42')
      expect(service.listArchives).toHaveBeenCalledWith('char-42')
      expect(result).toContain('session session-b')
      expect(result).toContain('Android 折腾')
      expect(result).toContain('round 1')
      expect(result).toContain('debug keystore')
    })

    it('caps how many sessions one search loads, newest first', async () => {
      const metas = Array.from({ length: 60 }, (_, i) => ({ sessionId: `s-${i}`, updatedAt: i }))
      const service = createService({
        listSessions: vi.fn<HistoryToolsService['listSessions']>().mockResolvedValue(metas),
      })
      const { search } = await mountTools(service)

      await search.execute({ query: 'keystore', limit: null }, ctx)

      // 40 newest of 60: s-59 down to s-20, and never the oldest.
      expect(service.readSession).toHaveBeenCalledTimes(40)
      expect(service.readSession).toHaveBeenCalledWith('s-59')
      expect(service.readSession).not.toHaveBeenCalledWith('s-0')
    })

    it('clamps a limit the schema can no longer bound after the nullable collapse', async () => {
      const service = createService({
        listSessions: vi.fn<HistoryToolsService['listSessions']>().mockResolvedValue([{ sessionId: 's-1' }]),
        readSession: vi.fn<HistoryToolsService['readSession']>().mockResolvedValue(
          Array.from({ length: 40 }, (_, i) => user(`keystore note ${i}`)),
        ),
      })
      const { search } = await mountTools(service)

      const result = await search.execute({ query: 'keystore', limit: 999 }, ctx) as string

      expect(result).toContain('20 matches')
    })

    it('says so plainly when nothing matched, instead of returning an empty list', async () => {
      const service = createService({
        listSessions: vi.fn<HistoryToolsService['listSessions']>().mockResolvedValue([{ sessionId: 's-1' }]),
        readSession: vi.fn<HistoryToolsService['readSession']>().mockResolvedValue([user('lunch plans')]),
      })
      const { search } = await mountTools(service)

      const result = await search.execute({ query: 'keystore', limit: null }, ctx) as string

      expect(result).toContain('Nothing in your past conversations matched')
      expect(result).toContain('a different wording may still find it')
    })

    it('does not touch storage for an empty query', async () => {
      const service = createService()
      const { search } = await mountTools(service)

      const result = await search.execute({ query: '   ', limit: null }, ctx) as string

      expect(result).toContain('the query was empty')
      expect(service.listSessions).not.toHaveBeenCalled()
    })
  })

  describe('history_read', () => {
    it('reads the requested round range of a session', async () => {
      const service = createService({
        readSession: vi.fn<HistoryToolsService['readSession']>().mockResolvedValue([
          user('first question'),
          assistant('first answer'),
          user('second question'),
          assistant('second answer'),
        ]),
      })
      const { read } = await mountTools(service)

      const result = await read.execute({ session_id: 's-1', round_from: 2, round_to: 2, archive_id: null }, ctx) as string

      expect(service.readSession).toHaveBeenCalledWith('s-1')
      expect(result).toContain('--- round 2 ---')
      expect(result).toContain('user: second question')
      expect(result).toContain('assistant: second answer')
      expect(result).not.toContain('first question')
    })

    it('caps a range wide enough to flood the context', async () => {
      const service = createService({
        readSession: vi.fn<HistoryToolsService['readSession']>().mockResolvedValue(
          Array.from({ length: 60 }, (_, i) => user(`turn ${i}`)),
        ),
      })
      const { read } = await mountTools(service)

      const result = await read.execute({ session_id: 's-1', round_from: 1, round_to: 999, archive_id: null }, ctx) as string

      expect(result).toContain('rounds 1-12')
      expect(result).toContain('--- round 12 ---')
      expect(result).not.toContain('--- round 13 ---')
    })

    it('reads an archive by id, showing the summary and the original messages', async () => {
      const service = createService({
        listArchives: vi.fn<HistoryToolsService['listArchives']>().mockResolvedValue([archive({
          roundFrom: 7,
          roundTo: 7,
          rawMessages: [user('archived question'), assistant('archived answer')],
        })]),
      })
      const { read } = await mountTools(service)

      const result = await read.execute({ session_id: null, round_from: null, round_to: null, archive_id: 'archive-1' }, ctx) as string

      expect(result).toContain('They settled on the debug keystore.')
      expect(result).toContain('--- round 7 ---')
      expect(result).toContain('user: archived question')
      expect(service.readSession).not.toHaveBeenCalled()
    })

    it('tells the model to search again when the id no longer exists', async () => {
      const { read } = await mountTools(createService())

      const missingSession = await read.execute({ session_id: 'gone', round_from: 1, round_to: 1, archive_id: null }, ctx) as string
      expect(missingSession).toContain('run history_search again')

      const missingArchive = await read.execute({ session_id: null, round_from: null, round_to: null, archive_id: 'gone' }, ctx) as string
      expect(missingArchive).toContain('No archived conversation with id "gone"')
    })

    it('refuses a call that identifies nothing to read', async () => {
      const service = createService()
      const { read } = await mountTools(service)

      const result = await read.execute({ session_id: null, round_from: null, round_to: null, archive_id: null }, ctx) as string

      expect(result).toContain('pass either a session_id or an archive_id')
      expect(service.readSession).not.toHaveBeenCalled()
    })
  })
})
