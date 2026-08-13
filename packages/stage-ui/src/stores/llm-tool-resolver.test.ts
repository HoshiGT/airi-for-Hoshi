import type { Tool } from '@xsai/shared-chat'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveLlmTools, toolNameFrom } from './llm-tool-resolver'

// The default (non-injected) web-search and memory branches read their module
// stores and the tools barrel; mock all of them so the configured-gate, key-trim
// and id-resolution logic can be exercised without real Pinia state, a live
// Tavily factory, or an opened memory database.
const {
  createWebSearchToolsMock,
  useWebSearchStoreMock,
  createMemoryToolsMock,
  createHistoryToolsMock,
  useMemoryStoreMock,
  useMemoryServiceMock,
  useChatSessionStoreMock,
  useAiriCardStoreMock,
} = vi.hoisted(() => ({
  createWebSearchToolsMock: vi.fn(),
  useWebSearchStoreMock: vi.fn(),
  createMemoryToolsMock: vi.fn(),
  createHistoryToolsMock: vi.fn(),
  useMemoryStoreMock: vi.fn(),
  useMemoryServiceMock: vi.fn(),
  useChatSessionStoreMock: vi.fn(),
  useAiriCardStoreMock: vi.fn(),
}))

vi.mock('../tools', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  return {
    ...actual,
    createWebSearchTools: createWebSearchToolsMock,
    createMemoryTools: createMemoryToolsMock,
    createHistoryTools: createHistoryToolsMock,
  }
})

vi.mock('./modules/web-search', () => ({
  useWebSearchStore: useWebSearchStoreMock,
}))

vi.mock('./modules/memory', () => ({
  useMemoryStore: useMemoryStoreMock,
}))

vi.mock('./chat/memory', () => ({
  useMemoryService: useMemoryServiceMock,
}))

vi.mock('./chat/session-store', () => ({
  useChatSessionStore: useChatSessionStoreMock,
}))

vi.mock('./modules/airi-card', () => ({
  useAiriCardStore: useAiriCardStoreMock,
}))

function createTool(name: string, description = `${name} description`): Tool {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    execute: vi.fn(),
  } as Tool
}

beforeEach(() => {
  // Every suite below asserts on an exact tool list, so the history branch has
  // to contribute nothing unless the test is specifically about it. It shares
  // the memory gate, which several suites turn on.
  createHistoryToolsMock.mockReset()
  createHistoryToolsMock.mockResolvedValue([])
})

describe('toolNameFrom', () => {
  it('reads function.name', () => {
    expect(toolNameFrom(createTool('runtime_read_context'))).toBe('runtime_read_context')
  })
})

describe('resolveLlmTools', () => {
  it('prefers a later runtime tool with the same name over an earlier built-in tool', async () => {
    const builtInTool = createTool('duplicate_tool', 'Built-in version.')
    const runtimeTool = createTool('duplicate_tool', 'Runtime version.')

    const tools = await resolveLlmTools({
      builtInTools: [builtInTool],
      sparkCommandTools: [],
      webSearchTools: [],
      memoryTools: [],
      historyTools: [],
      activeTools: [runtimeTool],
    })

    expect(tools).toHaveLength(1)
    expect(tools[0]).toBe(runtimeTool)
  })

  it('places custom tools before active runtime tools so runtime tools can win by name', async () => {
    const builtInTool = createTool('built_in_tool')
    const customTool = createTool('duplicate_tool', 'Custom version.')
    const runtimeTool = createTool('duplicate_tool', 'Runtime version.')

    const tools = await resolveLlmTools({
      builtInTools: [builtInTool],
      sparkCommandTools: [],
      webSearchTools: [],
      memoryTools: [],
      historyTools: [],
      customTools: [customTool],
      activeTools: [runtimeTool],
    })

    expect(tools).toEqual([builtInTool, runtimeTool])
  })

  it('includes injected web-search tools in the resolved list', async () => {
    const builtInTool = createTool('built_in_tool')
    const webSearchTool = createTool('web_search')

    const tools = await resolveLlmTools({
      builtInTools: [builtInTool],
      sparkCommandTools: [],
      webSearchTools: [webSearchTool],
      memoryTools: [],
      historyTools: [],
      activeTools: [],
    })

    expect(tools).toEqual([builtInTool, webSearchTool])
  })

  describe('default web-search branch (module store gate)', () => {
    beforeEach(() => {
      createWebSearchToolsMock.mockReset()
      useWebSearchStoreMock.mockReset()
      // Keep the memory branch out of the way: this block is about web search.
      useMemoryStoreMock.mockReturnValue({ toolsActive: false })
    })

    it('omits web_search when the web-search module is not configured', async () => {
      useWebSearchStoreMock.mockReturnValue({ configured: false, apiKey: '' })
      const builtInTool = createTool('built_in_tool')

      // webSearchTools is intentionally omitted so resolveWebSearchTools falls
      // through to the module store instead of the injected source.
      const tools = await resolveLlmTools({
        builtInTools: [builtInTool],
        sparkCommandTools: [],
        activeTools: [],
      })

      expect(tools).toEqual([builtInTool])
      expect(createWebSearchToolsMock).not.toHaveBeenCalled()
    })

    it('mounts web_search with a trimmed key when the module is configured', async () => {
      const webSearchTool = createTool('web_search')
      createWebSearchToolsMock.mockResolvedValue([webSearchTool])
      // A key pasted with surrounding whitespace still reads as configured, so
      // the resolver must trim it before handing it to the factory.
      useWebSearchStoreMock.mockReturnValue({ configured: true, apiKey: '  tvly-key\n' })
      const builtInTool = createTool('built_in_tool')

      const tools = await resolveLlmTools({
        builtInTools: [builtInTool],
        sparkCommandTools: [],
        activeTools: [],
      })

      expect(createWebSearchToolsMock).toHaveBeenCalledWith({ apiKey: 'tvly-key' })
      expect(tools).toEqual([builtInTool, webSearchTool])
    })
  })

  describe('default memory branch (module store gate)', () => {
    beforeEach(() => {
      createMemoryToolsMock.mockReset()
      useMemoryStoreMock.mockReset()
      useMemoryServiceMock.mockReset()
      useChatSessionStoreMock.mockReset()
      useAiriCardStoreMock.mockReset()
      // Keep the web-search branch out of the way: this block is about memory.
      useWebSearchStoreMock.mockReturnValue({ configured: false, apiKey: '' })
    })

    it('omits the memory tools while in-chat memory management is inactive', async () => {
      useMemoryStoreMock.mockReturnValue({ toolsActive: false })
      const builtInTool = createTool('built_in_tool')

      // memoryTools is intentionally omitted so resolveMemoryTools falls through
      // to the module store instead of the injected source.
      const tools = await resolveLlmTools({
        builtInTools: [builtInTool],
        sparkCommandTools: [],
        activeTools: [],
      })

      expect(tools).toEqual([builtInTool])
      expect(createMemoryToolsMock).not.toHaveBeenCalled()
      // The gate must short-circuit before the memory service store is created:
      // instantiating it opens the PGlite database for nothing.
      expect(useMemoryServiceMock).not.toHaveBeenCalled()
    })

    it('mounts the memory tools with the active session character when the module is active', async () => {
      const memoryTool = createTool('memory_save')
      createMemoryToolsMock.mockResolvedValue([memoryTool])
      useMemoryStoreMock.mockReturnValue({ toolsActive: true })
      const service = { addMemory: vi.fn(), recall: vi.fn(), removeMemory: vi.fn() }
      useMemoryServiceMock.mockReturnValue(service)
      useChatSessionStoreMock.mockReturnValue({
        activeSessionId: 'session-1',
        sessionMetas: { 'session-1': { characterId: 'char-42' } },
      })
      useAiriCardStoreMock.mockReturnValue({ activeCardId: 'card-fallback' })
      const builtInTool = createTool('built_in_tool')

      const tools = await resolveLlmTools({
        builtInTools: [builtInTool],
        sparkCommandTools: [],
        activeTools: [],
      })

      expect(tools).toEqual([builtInTool, memoryTool])
      const options = createMemoryToolsMock.mock.calls[0][0] as {
        service: unknown
        getCharacterId: () => string
        getSessionId: () => string
      }
      expect(options.service).toBe(service)
      // The session's own character wins over the active card.
      expect(options.getCharacterId()).toBe('char-42')
      expect(options.getSessionId()).toBe('session-1')
    })

    it('falls back to the active card, then to the default bucket, for the character id', async () => {
      createMemoryToolsMock.mockResolvedValue([])
      useMemoryStoreMock.mockReturnValue({ toolsActive: true })
      useMemoryServiceMock.mockReturnValue({})
      // A session with no meta yet (freshly forked, or a bridge session the index
      // has not hydrated) must not resolve to an empty character id.
      useChatSessionStoreMock.mockReturnValue({ activeSessionId: 'session-unknown', sessionMetas: {} })
      useAiriCardStoreMock.mockReturnValue({ activeCardId: 'card-fallback' })

      await resolveLlmTools({ builtInTools: [], sparkCommandTools: [], activeTools: [] })
      const withCard = createMemoryToolsMock.mock.calls[0][0] as { getCharacterId: () => string }
      expect(withCard.getCharacterId()).toBe('card-fallback')

      createMemoryToolsMock.mockClear()
      useAiriCardStoreMock.mockReturnValue({ activeCardId: '' })
      await resolveLlmTools({ builtInTools: [], sparkCommandTools: [], activeTools: [] })
      const withoutCard = createMemoryToolsMock.mock.calls[0][0] as { getCharacterId: () => string }
      expect(withoutCard.getCharacterId()).toBe('default')
    })
  })

  describe('default history branch (module store gate)', () => {
    interface HistoryOptions {
      getCharacterId: () => string
      service: {
        listSessions: (characterId: string) => Promise<{ sessionId: string, title?: string, updatedAt?: number }[]>
        readSession: (sessionId: string) => Promise<unknown[]>
        listArchives: (characterId: string) => Promise<unknown[]>
      }
    }

    beforeEach(() => {
      createMemoryToolsMock.mockReset()
      createMemoryToolsMock.mockResolvedValue([])
      createHistoryToolsMock.mockReset()
      useMemoryStoreMock.mockReset()
      useMemoryServiceMock.mockReset()
      useChatSessionStoreMock.mockReset()
      useAiriCardStoreMock.mockReset()
      useWebSearchStoreMock.mockReturnValue({ configured: false, apiKey: '' })
    })

    it('omits the history tools while in-chat memory management is inactive', async () => {
      useMemoryStoreMock.mockReturnValue({ toolsActive: false })
      const builtInTool = createTool('built_in_tool')

      const tools = await resolveLlmTools({
        builtInTools: [builtInTool],
        sparkCommandTools: [],
        activeTools: [],
      })

      expect(tools).toEqual([builtInTool])
      expect(createHistoryToolsMock).not.toHaveBeenCalled()
      // Same reason as the memory gate: creating the service store would open
      // the PGlite database for tools nobody mounted.
      expect(useMemoryServiceMock).not.toHaveBeenCalled()
    })

    it('mounts the history tools alongside memory when the module is active', async () => {
      const historyTool = createTool('history_search')
      createHistoryToolsMock.mockResolvedValue([historyTool])
      useMemoryStoreMock.mockReturnValue({ toolsActive: true })
      useMemoryServiceMock.mockReturnValue({ listArchives: vi.fn() })
      useChatSessionStoreMock.mockReturnValue({
        activeSessionId: 'session-1',
        sessionMetas: { 'session-1': { characterId: 'char-42' } },
        sessionMessages: {},
        loadSession: vi.fn(),
      })
      useAiriCardStoreMock.mockReturnValue({ activeCardId: 'card-fallback' })
      const builtInTool = createTool('built_in_tool')

      const tools = await resolveLlmTools({
        builtInTools: [builtInTool],
        sparkCommandTools: [],
        activeTools: [],
      })

      expect(tools).toEqual([builtInTool, historyTool])
      const options = createHistoryToolsMock.mock.calls[0][0] as HistoryOptions
      expect(options.getCharacterId()).toBe('char-42')
    })

    it('lists only the sessions belonging to the searching character', async () => {
      createHistoryToolsMock.mockResolvedValue([])
      useMemoryStoreMock.mockReturnValue({ toolsActive: true })
      useMemoryServiceMock.mockReturnValue({ listArchives: vi.fn() })
      useChatSessionStoreMock.mockReturnValue({
        activeSessionId: 'session-1',
        sessionMetas: {
          'session-1': { sessionId: 'session-1', characterId: 'char-42', title: 'Today', updatedAt: 2 },
          'session-2': { sessionId: 'session-2', characterId: 'char-42', updatedAt: 1 },
          'session-3': { sessionId: 'session-3', characterId: 'someone-else', updatedAt: 3 },
        },
        sessionMessages: {},
        loadSession: vi.fn(),
      })
      useAiriCardStoreMock.mockReturnValue({ activeCardId: '' })

      await resolveLlmTools({ builtInTools: [], sparkCommandTools: [], activeTools: [] })

      const { service } = createHistoryToolsMock.mock.calls[0][0] as HistoryOptions
      expect(await service.listSessions('char-42')).toEqual([
        { sessionId: 'session-1', title: 'Today', updatedAt: 2 },
        { sessionId: 'session-2', title: undefined, updatedAt: 1 },
      ])
    })

    it('loads a session through the store before reading it, so lazily-stored history is not missed', async () => {
      createHistoryToolsMock.mockResolvedValue([])
      useMemoryStoreMock.mockReturnValue({ toolsActive: true })
      useMemoryServiceMock.mockReturnValue({ listArchives: vi.fn() })
      const sessionMessages: Record<string, unknown[]> = {}
      const loadSession = vi.fn(async (sessionId: string) => {
        // Stand in for the IDB hydrate: messages only exist after the load.
        sessionMessages[sessionId] = [{ role: 'user', content: 'hydrated' }]
      })
      useChatSessionStoreMock.mockReturnValue({
        activeSessionId: 'session-1',
        sessionMetas: {},
        sessionMessages,
        loadSession,
      })
      useAiriCardStoreMock.mockReturnValue({ activeCardId: 'char-42' })

      await resolveLlmTools({ builtInTools: [], sparkCommandTools: [], activeTools: [] })

      const { service } = createHistoryToolsMock.mock.calls[0][0] as HistoryOptions
      expect(await service.readSession('session-9')).toEqual([{ role: 'user', content: 'hydrated' }])
      expect(loadSession).toHaveBeenCalledWith('session-9')
    })

    it('scopes archive lookups to the searching character', async () => {
      createHistoryToolsMock.mockResolvedValue([])
      useMemoryStoreMock.mockReturnValue({ toolsActive: true })
      const listArchives = vi.fn().mockResolvedValue([])
      useMemoryServiceMock.mockReturnValue({ listArchives })
      useChatSessionStoreMock.mockReturnValue({
        activeSessionId: 'session-1',
        sessionMetas: {},
        sessionMessages: {},
        loadSession: vi.fn(),
      })
      useAiriCardStoreMock.mockReturnValue({ activeCardId: 'char-42' })

      await resolveLlmTools({ builtInTools: [], sparkCommandTools: [], activeTools: [] })

      const { service } = createHistoryToolsMock.mock.calls[0][0] as HistoryOptions
      await service.listArchives('char-42')
      expect(listArchives).toHaveBeenCalledWith({ characterId: 'char-42' })
    })
  })
})
