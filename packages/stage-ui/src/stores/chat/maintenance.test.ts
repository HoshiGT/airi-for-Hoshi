import type { ChatHistoryItem } from '../../types/chat'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const configuredRef = { value: true }
const trimAfterConsolidationRef = { value: true }
const consolidateMock = vi.fn()
const consolidatingRef = { value: false }
const undoLastConsolidationMock = vi.fn()
const undoableConsolidationCountMock = vi.fn(async () => 0)
const consolidatedThroughRoundMock = vi.fn(async () => 0)

const sessionMessages = new Map<string, ChatHistoryItem[]>()
const setSessionMessagesMock = vi.fn((sessionId: string, messages: ChatHistoryItem[]) => {
  sessionMessages.set(sessionId, messages)
})
const notifySessionsRewrittenMock = vi.fn(async () => {})
const initializeMock = vi.fn(async () => {})
const loadSessionMock = vi.fn(async () => {})

// The orchestrator pulls the whole chat runtime (providers, streams, tools);
// none of that is exercised by the maintenance flow under test.
vi.mock('../chat', () => ({
  useChatOrchestratorStore: () => ({ cancelPendingSends: vi.fn() }),
  toProviderHistory: (messages: ChatHistoryItem[]) => messages.filter(m => m.role !== 'error'),
}))

vi.mock('./context-store', () => ({
  useChatContextStore: () => ({ resetContexts: vi.fn() }),
}))

vi.mock('./stream-store', () => ({
  useChatStreamStore: () => ({ resetStream: vi.fn() }),
}))

vi.mock('./session-store', () => ({
  useChatSessionStore: () => ({
    activeSessionId: 'sess-1',
    sessionMetas: { 'sess-1': { characterId: 'card-1' } },
    initialize: initializeMock,
    loadSession: loadSessionMock,
    getSessionMessages: (sessionId: string) => sessionMessages.get(sessionId) ?? [],
    setSessionMessages: setSessionMessagesMock,
    cleanupMessages: vi.fn(),
    notifySessionsRewritten: notifySessionsRewrittenMock,
  }),
}))

vi.mock('../modules/airi-card', () => ({
  useAiriCardStore: () => ({ activeCardId: 'card-1' }),
}))

vi.mock('../modules/memory', () => ({
  useMemoryStore: () => ({
    get configured() { return configuredRef.value },
    get trimAfterConsolidation() { return trimAfterConsolidationRef.value },
    retainRounds: 2,
    triggerRounds: 30,
  }),
}))

vi.mock('./memory', () => ({
  useMemoryService: () => ({
    get consolidating() { return consolidatingRef.value },
    consolidate: consolidateMock,
    consolidatedThroughRound: consolidatedThroughRoundMock,
    undoLastConsolidation: undoLastConsolidationMock,
    undoableConsolidationCount: undoableConsolidationCountMock,
  }),
}))

const { useChatMaintenanceStore } = await import('./maintenance')

function msg(role: ChatHistoryItem['role'], id: string): ChatHistoryItem {
  return { role, content: `${role}:${id}`, id } as ChatHistoryItem
}

function seedSession(rounds: number) {
  const messages: ChatHistoryItem[] = [msg('system', 'sys')]
  for (let i = 0; i < rounds; i++) {
    messages.push(msg('user', `u${i}`))
    messages.push(msg('assistant', `a${i}`))
  }
  sessionMessages.set('sess-1', messages)
}

beforeEach(() => {
  setActivePinia(createPinia())
  configuredRef.value = true
  // The cases in this file assert the trimming contract, so they opt into it;
  // production defaults the other way (summarize, keep the conversation) and the
  // dedicated block at the bottom covers that.
  trimAfterConsolidationRef.value = true
  consolidatingRef.value = false
  consolidatedThroughRoundMock.mockReset().mockResolvedValue(0)
  sessionMessages.clear()
  consolidateMock.mockReset().mockResolvedValue({ summary: 's', items: [{}, {}, {}] })
  undoLastConsolidationMock.mockReset().mockResolvedValue(null)
  undoableConsolidationCountMock.mockReset().mockResolvedValue(0)
  setSessionMessagesMock.mockClear()
  notifySessionsRewrittenMock.mockClear()
  initializeMock.mockClear()
  loadSessionMock.mockClear()
})

describe('chat-maintenance · consolidateSessionNow', () => {
  it('returns not-configured without touching the session when no model is set', async () => {
    configuredRef.value = false
    const store = useChatMaintenanceStore()
    const result = await store.consolidateSessionNow()
    expect(result).toEqual({ status: 'not-configured' })
    expect(consolidateMock).not.toHaveBeenCalled()
    expect(setSessionMessagesMock).not.toHaveBeenCalled()
  })

  it('returns busy while an automatic pass is already running', async () => {
    consolidatingRef.value = true
    const store = useChatMaintenanceStore()
    const result = await store.consolidateSessionNow()
    expect(result).toEqual({ status: 'busy' })
    expect(consolidateMock).not.toHaveBeenCalled()
  })

  it('returns nothing-to-archive when the conversation fits the retained window', async () => {
    seedSession(2)
    const store = useChatMaintenanceStore()
    const result = await store.consolidateSessionNow()
    expect(result).toEqual({ status: 'nothing-to-archive' })
    expect(consolidateMock).not.toHaveBeenCalled()
  })

  it('consolidates below the trigger threshold, trims by id, and notifies other windows', async () => {
    // 5 rounds < triggerRounds 30: the manual pass must run anyway.
    seedSession(5)
    const store = useChatMaintenanceStore()
    const result = await store.consolidateSessionNow()

    expect(result).toEqual({ status: 'done', archivedRounds: 3, memoryCount: 3 })
    expect(initializeMock).toHaveBeenCalled()
    expect(loadSessionMock).toHaveBeenCalledWith('sess-1')
    expect(consolidateMock).toHaveBeenCalledTimes(1)
    // Rounds 1-3 (u0..a2) go to the model; the range is reported for drill-back.
    // (The options also carry archivedSessionMessages — asserted separately.)
    expect(consolidateMock.mock.calls[0][0]).toBe('card-1')
    expect(consolidateMock.mock.calls[0][1]).toBe('sess-1')
    expect(consolidateMock.mock.calls[0][3]).toMatchObject({ roundFrom: 1, roundTo: 3 })

    // Live history keeps the system head plus the retained 2 rounds.
    const trimmed = sessionMessages.get('sess-1')!
    expect(trimmed.map(m => m.id)).toEqual(['sys', 'u3', 'a3', 'u4', 'a4'])

    // The cross-window notify fires only after the trim landed.
    expect(notifySessionsRewrittenMock).toHaveBeenCalledTimes(1)
    expect(setSessionMessagesMock.mock.invocationCallOrder[0])
      .toBeLessThan(notifySessionsRewrittenMock.mock.invocationCallOrder[0])
  })

  it('keeps a message that arrived while the model call was running', async () => {
    seedSession(5)
    consolidateMock.mockImplementation(async () => {
      // Simulate the user typing mid-consolidation: appended AFTER the plan
      // snapshot was taken, so it must survive the id-based trim.
      sessionMessages.get('sess-1')!.push(msg('user', 'u-live'))
      return { summary: 's', items: [] }
    })

    const store = useChatMaintenanceStore()
    const result = await store.consolidateSessionNow()
    expect(result).toEqual({ status: 'done', archivedRounds: 3, memoryCount: 0 })
    expect(sessionMessages.get('sess-1')!.map(m => m.id)).toContain('u-live')
  })

  it('hands the raw session items to the service as the undo backup', async () => {
    seedSession(5)
    const store = useChatMaintenanceStore()
    await store.consolidateSessionNow()

    // Rounds 1-3 (u0..a2) were archived; the backup must be the session items
    // (ids included), not the provider-shaped history.
    const options = consolidateMock.mock.calls[0][3]
    expect((options.archivedSessionMessages as ChatHistoryItem[]).map(m => m.id))
      .toEqual(['u0', 'a0', 'u1', 'a1', 'u2', 'a2'])
  })
})

describe('chat-maintenance · consolidateSessionNow without trimming (default)', () => {
  beforeEach(() => {
    trimAfterConsolidationRef.value = false
  })

  it('produces memories while leaving the conversation at full precision', async () => {
    seedSession(5)
    const store = useChatMaintenanceStore()
    const before = [...sessionMessages.get('sess-1')!]

    const result = await store.consolidateSessionNow()

    expect(result).toEqual({ status: 'done', archivedRounds: 3, memoryCount: 3 })
    expect(consolidateMock).toHaveBeenCalledTimes(1)
    // Nothing left the conversation, so there is nothing to write back and no
    // undo backup to record (undo just drops the memories this pass produced).
    expect(setSessionMessagesMock).not.toHaveBeenCalled()
    expect(sessionMessages.get('sess-1')).toEqual(before)
    expect(consolidateMock.mock.calls[0][3]).not.toHaveProperty('archivedSessionMessages')
    // No rewrite happened, so sibling windows have nothing to reread.
    expect(notifySessionsRewrittenMock).not.toHaveBeenCalled()
  })

  it('resumes after the last summarized round instead of redoing the same rounds', async () => {
    // ROOT CAUSE:
    //
    // Trimming used to be what stopped a pass from seeing the same rounds twice.
    // With the conversation left intact, a second click would re-summarize rounds
    // 1-3 and duplicate every memory they produced.
    seedSession(8)
    consolidatedThroughRoundMock.mockResolvedValue(3)

    const store = useChatMaintenanceStore()
    const result = await store.consolidateSessionNow()

    expect(consolidatedThroughRoundMock).toHaveBeenCalledWith('sess-1')
    // 8 rounds, retain 2 → summarizable through round 6; rounds 1-3 are done.
    expect(consolidateMock.mock.calls[0][3]).toMatchObject({ roundFrom: 4, roundTo: 6 })
    expect(result).toEqual({ status: 'done', archivedRounds: 3, memoryCount: 3 })
  })

  it('reports nothing-to-archive when every eligible round is already summarized', async () => {
    seedSession(5)
    consolidatedThroughRoundMock.mockResolvedValue(3)

    const store = useChatMaintenanceStore()
    const result = await store.consolidateSessionNow()

    expect(result).toEqual({ status: 'nothing-to-archive' })
    expect(consolidateMock).not.toHaveBeenCalled()
  })
})

describe('chat-maintenance · undoLastConsolidation', () => {
  function recordedRun(overrides?: Partial<{ archivedMessages: unknown[], roundFrom: number | null, roundTo: number | null }>) {
    return {
      id: 'run-1',
      seq: 1,
      sessionId: 'sess-1',
      archivedMessages: [msg('user', 'u0'), msg('assistant', 'a0'), msg('user', 'u1'), msg('assistant', 'a1')],
      memoryIds: ['mem-1'],
      archiveId: 'arch-1',
      roundFrom: 1,
      roundTo: 2,
      createdAt: new Date(),
      ...overrides,
    }
  }

  it('returns busy while a consolidation pass is running', async () => {
    consolidatingRef.value = true
    const store = useChatMaintenanceStore()
    expect(await store.undoLastConsolidation()).toEqual({ status: 'busy' })
    expect(undoLastConsolidationMock).not.toHaveBeenCalled()
  })

  it('returns nothing-to-undo when no backup remains', async () => {
    seedSession(2)
    const store = useChatMaintenanceStore()
    expect(await store.undoLastConsolidation()).toEqual({ status: 'nothing-to-undo' })
    expect(setSessionMessagesMock).not.toHaveBeenCalled()
  })

  it('restores the trimmed rounds after the system head and notifies other windows', async () => {
    // Live session after a past trim: system head + retained rounds 3-4.
    sessionMessages.set('sess-1', [msg('system', 'sys'), msg('user', 'u2'), msg('assistant', 'a2')])
    undoLastConsolidationMock.mockResolvedValue(recordedRun())
    undoableConsolidationCountMock.mockResolvedValue(1)

    const store = useChatMaintenanceStore()
    const result = await store.undoLastConsolidation()

    expect(result).toEqual({ status: 'done', restoredRounds: 2, remainingUndoable: 1 })
    expect(undoLastConsolidationMock).toHaveBeenCalledWith('sess-1')
    // The restored block lands between the system head and the retained rounds
    // — its original position, since older archived rounds are not live.
    expect(sessionMessages.get('sess-1')!.map(m => m.id))
      .toEqual(['sys', 'u0', 'a0', 'u1', 'a1', 'u2', 'a2'])
    expect(notifySessionsRewrittenMock).toHaveBeenCalledTimes(1)
    expect(setSessionMessagesMock.mock.invocationCallOrder[0])
      .toBeLessThan(notifySessionsRewrittenMock.mock.invocationCallOrder[0])
  })

  it('dedupes by id so an already-live message is not inserted twice', async () => {
    sessionMessages.set('sess-1', [msg('system', 'sys'), msg('user', 'u1'), msg('user', 'u2')])
    // u1 is both in the backup and still live (e.g. a retried partial undo).
    undoLastConsolidationMock.mockResolvedValue(recordedRun())

    const store = useChatMaintenanceStore()
    await store.undoLastConsolidation()

    const ids = sessionMessages.get('sess-1')!.map(m => m.id)
    expect(ids.filter(id => id === 'u1')).toHaveLength(1)
    expect(ids).toEqual(['sys', 'u0', 'a0', 'a1', 'u1', 'u2'])
  })

  it('falls back to counting restored user turns when the run has no range', async () => {
    sessionMessages.set('sess-1', [msg('system', 'sys')])
    undoLastConsolidationMock.mockResolvedValue(recordedRun({ roundFrom: null, roundTo: null }))

    const store = useChatMaintenanceStore()
    const result = await store.undoLastConsolidation()
    expect(result).toMatchObject({ status: 'done', restoredRounds: 2 })
  })
})
