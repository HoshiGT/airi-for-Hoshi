import type { ChatSessionsIndex } from '../../types/chat-session'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

const userIdRef = ref<string>('local')
const activeCardIdRef = ref<string>('default')
const systemPromptRef = ref<string>('')
const cardsRef = ref<Map<string, unknown>>(new Map())

const enqueueOutboxMock = vi.fn(async () => {})
const listChatsMock = vi.fn(async () => [])
const wsDestroyMock = vi.fn()
const createChatWsClientMock = vi.fn(() => ({
  status: () => 'idle' as const,
  connect: vi.fn(),
  disconnect: vi.fn(),
  destroy: wsDestroyMock,
  sendMessages: vi.fn(async () => ({ ok: true })),
  pullMessages: vi.fn(async () => ({ messages: [], maxSeq: 0 })),
  onNewMessages: () => () => {},
  onStatusChange: () => () => {},
}))

vi.mock('pinia', async () => {
  const actual = await vi.importActual<typeof import('pinia')>('pinia')
  return {
    ...actual,
    storeToRefs: (store: any) => store,
  }
})

vi.mock('../auth', () => ({
  useAuthStore: () => ({ userId: userIdRef, token: ref('t') }),
}))

vi.mock('../modules/airi-card', () => ({
  useAiriCardStore: () => ({
    activeCardId: activeCardIdRef,
    cards: cardsRef,
    systemPrompt: systemPromptRef,
  }),
}))

vi.mock('../../database/repos/chat-sessions.repo', () => ({
  chatSessionsRepo: {
    getIndex: vi.fn(async (): Promise<ChatSessionsIndex | null> => null),
    saveIndex: vi.fn(async () => {}),
    getSession: vi.fn(async () => null),
    saveSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    getOutbox: vi.fn(async () => []),
    enqueueOutbox: (...args: unknown[]) => enqueueOutboxMock(...args as []),
    dequeueOutbox: vi.fn(async () => {}),
    updateOutboxEntries: vi.fn(async () => {}),
    dropOutboxForSession: vi.fn(async () => {}),
    getTombstones: vi.fn(async () => []),
    addTombstone: vi.fn(async () => {}),
    removeTombstones: vi.fn(async () => {}),
  },
}))

vi.mock('../../libs/auth', () => ({
  getAuthToken: vi.fn().mockResolvedValue('test-token'),
}))

vi.mock('../../libs/auth-fetch', () => ({
  authedFetch: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
}))

vi.mock('../../libs/server', () => ({
  SERVER_URL: 'http://test',
}))

vi.mock('../../libs/chat-sync', () => ({
  applyCreateActions: vi.fn().mockResolvedValue([]),
  reconcileLocalAndRemote: vi.fn().mockReturnValue({ adopt: [], claim: [], create: [] }),
  createCloudChatMapper: () => ({
    listChats: (...args: unknown[]) => listChatsMock(...args as []),
    deleteChat: vi.fn().mockResolvedValue(undefined),
  }),
  createChatWsClient: (...args: unknown[]) => createChatWsClientMock(...args as []),
  extractMessageText: (m: any) => (typeof m?.content === 'string' ? m.content : ''),
  isCloudSyncableMessage: () => false,
  mergeCloudMessagesIntoLocal: () => ({ dirty: false, messages: [], maxSeq: 0 }),
}))

const { useChatSessionStore } = await import('./session-store')

beforeEach(() => {
  setActivePinia(createPinia())
  userIdRef.value = 'cloud-user-1'
  activeCardIdRef.value = 'default'
  systemPromptRef.value = ''
  cardsRef.value = new Map()
  enqueueOutboxMock.mockClear()
  listChatsMock.mockClear()
  wsDestroyMock.mockClear()
  createChatWsClientMock.mockClear()
})

describe('chat-session-store · cloudSyncEnabled preference', () => {
  it('opens the WS and reconciles for a signed-in user when enabled (default)', async () => {
    const store = useChatSessionStore()
    store.cloudSyncEnabled = true
    await store.initialize()

    expect(createChatWsClientMock).toHaveBeenCalledTimes(1)
    // initialize → createSession (fresh user) → fire-and-forget reconcile.
    await new Promise(r => setTimeout(r, 0))
    expect(listChatsMock).toHaveBeenCalled()
  })

  it('opens no WS and never reconciles when disabled, even signed in', async () => {
    const store = useChatSessionStore()
    store.cloudSyncEnabled = false
    await nextTick()
    createChatWsClientMock.mockClear()

    await store.initialize()
    await new Promise(r => setTimeout(r, 0))

    expect(createChatWsClientMock).not.toHaveBeenCalled()
    expect(listChatsMock).not.toHaveBeenCalled()
  })

  it('does not enqueue outbox entries while disabled — messages stay local-only', async () => {
    const store = useChatSessionStore()
    store.cloudSyncEnabled = false
    await nextTick()

    await store.pushMessageToCloud('sess-1', { id: 'm1', role: 'user', content: 'hi' })
    expect(enqueueOutboxMock).not.toHaveBeenCalled()

    // Control: with sync on, the same call persists to the outbox.
    store.cloudSyncEnabled = true
    await nextTick()
    await store.pushMessageToCloud('sess-1', { id: 'm2', role: 'user', content: 'hi again' })
    expect(enqueueOutboxMock).toHaveBeenCalledTimes(1)
  })

  it('tears the WS down on toggle-off and reconnects on toggle-on', async () => {
    const store = useChatSessionStore()
    store.cloudSyncEnabled = true
    await store.initialize()
    expect(createChatWsClientMock).toHaveBeenCalledTimes(1)

    store.cloudSyncEnabled = false
    await nextTick()
    expect(wsDestroyMock).toHaveBeenCalledTimes(1)

    store.cloudSyncEnabled = true
    await nextTick()
    expect(createChatWsClientMock).toHaveBeenCalledTimes(2)
  })
})
