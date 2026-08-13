import type { StreamOptions } from '@proj-airi/core-agent'
import type { WebSocketEvents } from '@proj-airi/server-sdk'
import type { Tool } from '@xsai/shared-chat'

import { uniqBy } from 'es-toolkit'

import { createHistoryTools, createMemoryTools, createSparkCommandTool, createWebSearchTools, mcp } from '../tools'
import { useMemoryService } from './chat/memory'
import { useChatSessionStore } from './chat/session-store'
import { useLlmToolsStore } from './llm-tools'
import { useModsServerChannelStore } from './mods/api/channel-server'
import { useAiriCardStore } from './modules/airi-card'
import { useMemoryStore } from './modules/memory'
import { useWebSearchStore } from './modules/web-search'

type ToolSource = Tool[] | (() => Promise<Tool[]>)

/**
 * Overrides for resolving the complete LLM-visible tool list.
 *
 * Production callers normally pass only {@link customTools}; tests can inject
 * every source to exercise merge and precedence policy without real stores.
 */
export interface ResolveLlmToolsOptions {
  /**
   * MCP-backed built-in tools.
   *
   * @default mcp()
   */
  builtInTools?: ToolSource
  /**
   * Spark command tools. Supplying this also avoids creating the mods server
   * channel store.
   *
   * @default createSparkCommandTool(...)
   */
  sparkCommandTools?: ToolSource
  /**
   * Web search tools. Supplying this also avoids reading the web-search module
   * store; by default the tool is included only when a Tavily API key is
   * configured (a keyless search can only error).
   *
   * @default gated on useWebSearchStore().configured
   */
  webSearchTools?: ToolSource
  /**
   * Memory curation tools (`memory_save` / `memory_recall` / `memory_forget`).
   * Supplying this also avoids reading the memory module store and opening the
   * memory database; by default the tools are included only while the memory
   * module is configured and in-chat memory management is enabled.
   *
   * @default gated on useMemoryStore().toolsActive
   */
  memoryTools?: ToolSource
  /**
   * Conversation history tools (`history_search` / `history_read`). Gated on the
   * same flag as {@link memoryTools}: they are the transcript half of the same
   * remembering capability, and the paired prompt explains them as a pair.
   *
   * @default gated on useMemoryStore().toolsActive
   */
  historyTools?: ToolSource
  /**
   * Request-scoped tools from {@link StreamOptions.tools}. These are ordered
   * before active runtime tools so runtime registrations can intentionally
   * override a request tool with the same name.
   */
  customTools?: StreamOptions['tools']
  /**
   * Runtime-registered tools currently active in the LLM tool store. Supplying
   * this also avoids creating the LLM tool store.
   *
   * @default useLlmToolsStore().activeTools
   */
  activeTools?: Tool[]
}

/**
 * Reads the provider-visible name from an xsai tool.
 */
export function toolNameFrom(tool: Tool): string | undefined {
  const candidate = tool as Tool & {
    name?: string
    function?: {
      name?: string
    }
  }

  return candidate.function?.name ?? candidate.name
}

async function resolveToolSource(source: ToolSource): Promise<Tool[]> {
  return typeof source === 'function' ? await source() : source
}

async function resolveCustomTools(customTools: StreamOptions['tools']): Promise<Tool[]> {
  if (typeof customTools === 'function')
    return await customTools() ?? []

  return customTools ?? []
}

async function resolveActiveTools(activeTools?: Tool[]): Promise<Tool[]> {
  if (activeTools != null)
    return activeTools

  const llmToolsStore = useLlmToolsStore()
  await llmToolsStore.awaitPendingRegistrations()
  return llmToolsStore.activeTools
}

async function resolveSparkCommandTools(sparkCommandTools?: ToolSource): Promise<Tool[]> {
  if (sparkCommandTools != null)
    return resolveToolSource(sparkCommandTools)

  const modsServerChannelStore = useModsServerChannelStore()
  const sendSparkCommand = (command: WebSocketEvents['spark:command']) => {
    // TODO(@nekomeowww): instruct the LLM to understand what destination is.
    // Currently without skill like prompt injection, many issues occur.
    // destination mostly are wrong or hallucinated, we need to find a way to make it more reliable.
    //
    // For now, since destinations as array will always broadcast to all connected modules/agents, we can set it to
    // empty array to avoid wrong routing.
    command.destinations = []

    modsServerChannelStore.send({
      type: 'spark:command',
      data: command,
    })
  }

  return createSparkCommandTool({ sendSparkCommand })
}

async function resolveWebSearchTools(webSearchTools?: ToolSource): Promise<Tool[]> {
  if (webSearchTools != null)
    return resolveToolSource(webSearchTools)

  const webSearchStore = useWebSearchStore()
  // A keyless search can only ever error, so omit the tool until configured.
  if (!webSearchStore.configured)
    return []

  // Trim the key: `configured` is computed on the trimmed value, so a key pasted
  // with trailing whitespace/newline reads as ready but would 401 if sent raw.
  return createWebSearchTools({ apiKey: webSearchStore.apiKey.trim() })
}

async function resolveMemoryTools(memoryTools?: ToolSource): Promise<Tool[]> {
  if (memoryTools != null)
    return resolveToolSource(memoryTools)

  const memoryStore = useMemoryStore()
  // Omit the tools entirely rather than mounting no-ops: the paired toolset
  // prompt is gated on the same flag, so an unconfigured module leaves the model
  // with neither the tools nor any mention of them.
  if (!memoryStore.toolsActive)
    return []

  const memoryService = useMemoryService()
  const chatSession = useChatSessionStore()

  return createMemoryTools({
    service: memoryService,
    getCharacterId: resolveOwningCharacterId,
    // NOTICE: the resolver has no per-turn session context, so a memory saved
    // during a bridged turn (a QQ DM, say) is attributed to the session the UI
    // has open rather than the one that triggered it. Recall is scoped by
    // character and ignores sessionId, so this only mislabels provenance; fixing
    // it properly means threading the turn's sessionId through StreamOptions.
    getSessionId: () => chatSession.activeSessionId,
  })
}

/**
 * Resolves the character id whose data the memory and history tools may touch.
 *
 * Mirrors how the consolidation pass resolves ownership in `chat.ts`: the
 * session's own character wins, then the active card, then the 'default' bucket
 * a fresh install writes into. Read per call so switching cards mid-session
 * cannot leak one character's memories or conversations into another's.
 */
function resolveOwningCharacterId(): string {
  const chatSession = useChatSessionStore()
  const cardStore = useAiriCardStore()
  return chatSession.sessionMetas[chatSession.activeSessionId]?.characterId || cardStore.activeCardId || 'default'
}

async function resolveHistoryTools(historyTools?: ToolSource): Promise<Tool[]> {
  if (historyTools != null)
    return resolveToolSource(historyTools)

  const memoryStore = useMemoryStore()
  if (!memoryStore.toolsActive)
    return []

  const memoryService = useMemoryService()
  const chatSession = useChatSessionStore()

  return createHistoryTools({
    getCharacterId: resolveOwningCharacterId,
    service: {
      // `sessionMetas` is hydrated from the sessions index for every character
      // at startup, so listing does not need to touch IndexedDB — only the
      // sessions the search actually scans get their messages loaded.
      listSessions: async characterId => Object.values(chatSession.sessionMetas)
        .filter(meta => meta.characterId === characterId)
        .map(meta => ({ sessionId: meta.sessionId, title: meta.title, updatedAt: meta.updatedAt })),
      // Goes through `loadSession` rather than the repo directly so a scanned
      // session lands in the store's normal loaded state (and its cloud gap fill
      // runs once), instead of building a second, divergent copy of the history.
      readSession: async (sessionId) => {
        await chatSession.loadSession(sessionId)
        return chatSession.sessionMessages[sessionId] ?? []
      },
      listArchives: async characterId => memoryService.listArchives({ characterId }),
    },
  })
}

/**
 * Resolves every tool visible to an LLM request.
 *
 * Runtime tools are placed last before de-duplication. The reverse/uniq/reverse
 * pass preserves the existing stable order while letting later runtime
 * registrations win when names collide with built-in or custom tools.
 */
export async function resolveLlmTools(options: ResolveLlmToolsOptions = {}): Promise<Tool[]> {
  const activeTools = await resolveActiveTools(options.activeTools)
  const [
    builtInTools,
    sparkCommandTools,
    webSearchTools,
    memoryTools,
    historyTools,
    customTools,
  ] = await Promise.all([
    resolveToolSource(options.builtInTools ?? mcp),
    resolveSparkCommandTools(options.sparkCommandTools),
    resolveWebSearchTools(options.webSearchTools),
    resolveMemoryTools(options.memoryTools),
    resolveHistoryTools(options.historyTools),
    resolveCustomTools(options.customTools),
  ])

  return uniqBy(
    [
      ...builtInTools,
      ...sparkCommandTools,
      ...webSearchTools,
      ...memoryTools,
      ...historyTools,
      ...customTools,
      ...activeTools,
    ].toReversed(),
    tool => toolNameFrom(tool) ?? tool,
  ).toReversed()
}
