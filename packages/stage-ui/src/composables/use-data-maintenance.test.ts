import type { ChatSessionsExport } from '../types/chat-session'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDataMaintenance } from './use-data-maintenance'

// The composable touches ~18 stores; only the three involved in chat backup
// carry behavior here. The shared call log pins the import ORDER, which is the
// actual policy under test: cards must land before sessions (importSessions
// keeps card linkage only for cards that already exist), and the active-card
// switch must run last so the session watcher sees the imported index.
const h = vi.hoisted(() => {
  const callLog: string[] = []
  const chatStore = {
    exportSessions: vi.fn(async (): Promise<ChatSessionsExport> => ({
      format: 'chat-sessions-index:v1',
      index: { userId: 'local', characters: {} },
      sessions: {},
    })),
    importSessions: vi.fn(async () => {
      callLog.push('importSessions')
    }),
  }
  const cardStore = {
    activeCardId: 'default',
    cards: new Map<string, unknown>([['default', { name: 'ReLU' }]]),
    exportCards: vi.fn(() => ({ default: { name: 'ReLU', version: '1.0.0' } })),
    importCards: vi.fn((imported: Record<string, unknown>) => {
      callLog.push('importCards')
      for (const [id, card] of Object.entries(imported)) {
        if (!cardStore.cards.has(id))
          cardStore.cards.set(id, card)
      }
      return Object.keys(imported)
    }),
  }
  const memoryService = {
    exportMemory: vi.fn(async () => ({ memoryItems: [], archivedSummaries: [], consolidationRuns: [] })),
    importMemory: vi.fn(async () => {
      callLog.push('importMemory')
    }),
  }
  return { callLog, chatStore, cardStore, memoryService }
})

vi.mock('@proj-airi/stage-shared', () => ({ isStageTamagotchi: () => false }))
vi.mock('@proj-airi/stage-ui-live2d', () => ({ useLive2dParams: () => ({}), useSettingsLive2d: () => ({}) }))
vi.mock('@proj-airi/stage-ui-three', () => ({ useModelStore: () => ({}) }))
vi.mock('../stores/chat', () => ({ useChatOrchestratorStore: () => ({ cancelPendingSends: vi.fn() }) }))
vi.mock('../stores/chat/memory', () => ({ useMemoryService: () => h.memoryService }))
vi.mock('../stores/chat/session-store', () => ({ useChatSessionStore: () => h.chatStore }))
vi.mock('../stores/display-models', () => ({ useDisplayModelsStore: () => ({}) }))
vi.mock('../stores/mcp', () => ({ useMcpStore: () => ({}) }))
vi.mock('../stores/modules/airi-card', () => ({ useAiriCardStore: () => h.cardStore }))
vi.mock('../stores/modules/consciousness', () => ({ useConsciousnessStore: () => ({}) }))
vi.mock('../stores/modules/discord', () => ({ useDiscordStore: () => ({}) }))
vi.mock('../stores/modules/gaming-factorio', () => ({ useFactorioStore: () => ({}) }))
vi.mock('../stores/modules/gaming-minecraft', () => ({ useMinecraftStore: () => ({}) }))
vi.mock('../stores/modules/hearing', () => ({ useHearingStore: () => ({}) }))
vi.mock('../stores/modules/speech', () => ({ useSpeechStore: () => ({}) }))
vi.mock('../stores/modules/twitter', () => ({ useTwitterStore: () => ({}) }))
vi.mock('../stores/onboarding', () => ({ useOnboardingStore: () => ({}) }))
vi.mock('../stores/providers', () => ({ useProvidersStore: () => ({}) }))
vi.mock('../stores/settings', () => ({ useSettings: () => ({}), useSettingsAudioDevice: () => ({}) }))

function makeSessionsPayload(extras?: Partial<ChatSessionsExport>): Record<string, unknown> {
  return {
    format: 'chat-sessions-index:v1',
    index: { userId: 'exporter', characters: {} },
    sessions: {},
    ...extras,
  }
}

beforeEach(() => {
  h.callLog.length = 0
  h.cardStore.activeCardId = 'default'
  h.cardStore.cards = new Map([['default', { name: 'ReLU' }]])
  h.chatStore.importSessions.mockClear()
  h.cardStore.importCards.mockClear()
  h.memoryService.importMemory.mockClear()
})

describe('useDataMaintenance · chat backup export', () => {
  it('bundles cards, the active card id, and memory into the export file', async () => {
    const { exportChatSessions } = useDataMaintenance()

    const blob = await exportChatSessions()
    const payload = JSON.parse(await blob.text()) as ChatSessionsExport

    expect(payload.format).toBe('chat-sessions-index:v1')
    expect(payload.cards).toEqual({ default: { name: 'ReLU', version: '1.0.0' } })
    expect(payload.activeCardId).toBe('default')
    expect(payload.memory).toEqual({ memoryItems: [], archivedSummaries: [], consolidationRuns: [] })
  })
})

describe('useDataMaintenance · chat backup import', () => {
  it('imports cards before sessions and memory after, then switches to the exporter\'s card', async () => {
    const { importChatSessions } = useDataMaintenance()

    await importChatSessions(makeSessionsPayload({
      cards: { 'card-x': { name: 'Yuki', version: '1.0.0' } },
      activeCardId: 'card-x',
      memory: { memoryItems: [], archivedSummaries: [], consolidationRuns: [] },
    }))

    expect(h.callLog).toEqual(['importCards', 'importSessions', 'importMemory'])
    expect(h.cardStore.activeCardId).toBe('card-x')
  })

  it('imports a sessions-only file (no cards / activeCardId / memory sections)', async () => {
    const { importChatSessions } = useDataMaintenance()

    await importChatSessions(makeSessionsPayload())

    expect(h.callLog).toEqual(['importSessions'])
    expect(h.cardStore.importCards).not.toHaveBeenCalled()
    expect(h.memoryService.importMemory).not.toHaveBeenCalled()
    expect(h.cardStore.activeCardId).toBe('default')
  })

  it('does not switch to an exporter card that is absent locally', async () => {
    const { importChatSessions } = useDataMaintenance()

    // activeCardId points at a card the file does not carry (hand-trimmed
    // backup); switching would strand the stage on a bucket with no card.
    await importChatSessions(makeSessionsPayload({ activeCardId: 'ghost-card' }))

    expect(h.cardStore.activeCardId).toBe('default')
  })

  it('rejects files that are not a chat backup', async () => {
    const { importChatSessions } = useDataMaintenance()

    await expect(importChatSessions({ format: 'something-else' })).rejects.toThrow('Invalid chat session export format')
    expect(h.callLog).toEqual([])
  })
})
