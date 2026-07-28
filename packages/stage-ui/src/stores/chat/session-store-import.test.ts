import type { ChatHistoryItem } from '../../types/chat'
import type { ChatSessionMeta, ChatSessionRecord, ChatSessionsExport, ChatSessionsIndex } from '../../types/chat-session'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// Refs the store reads through the mocked `useAuthStore` / `useAiriCardStore`.
// Tests mutate these to simulate auth and card swaps.
const userIdRef = ref<string>('local')
const activeCardIdRef = ref<string>('default')
const systemPromptRef = ref<string>('')
const cardsRef = ref<Map<string, unknown>>(new Map())

// Map-backed fake of the per-user index buckets and per-session records the
// real repo keeps in IDB (`local:chat/index/${userId}` / `local:chat/sessions/${id}`).
// The import bug under test is exactly a wrong-bucket write, so the fake must
// preserve the keying behavior instead of returning canned values.
const storedIndexes = new Map<string, ChatSessionsIndex>()
const storedSessions = new Map<string, ChatSessionRecord>()

const getIndexMock = vi.fn(async (uid: string) => storedIndexes.get(uid) ?? null)
const saveIndexMock = vi.fn(async (idx: ChatSessionsIndex) => {
  storedIndexes.set(idx.userId, idx)
})
const getSessionMock = vi.fn(async (id: string) => storedSessions.get(id) ?? null)
const saveSessionMock = vi.fn(async (id: string, rec: ChatSessionRecord) => {
  storedSessions.set(id, rec)
})

vi.mock('pinia', async () => {
  const actual = await vi.importActual<typeof import('pinia')>('pinia')
  return {
    ...actual,
    storeToRefs: (store: any) => store,
  }
})

vi.mock('../auth', () => ({
  useAuthStore: () => ({ userId: userIdRef }),
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
    getIndex: (uid: string) => getIndexMock(uid),
    saveIndex: (idx: ChatSessionsIndex) => saveIndexMock(idx),
    getSession: (id: string) => getSessionMock(id),
    saveSession: (id: string, rec: ChatSessionRecord) => saveSessionMock(id, rec),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    getOutbox: vi.fn().mockResolvedValue([]),
    enqueueOutbox: vi.fn().mockResolvedValue(undefined),
    dequeueOutbox: vi.fn().mockResolvedValue(undefined),
    updateOutboxEntries: vi.fn().mockResolvedValue(undefined),
    dropOutboxForSession: vi.fn().mockResolvedValue(undefined),
    getTombstones: vi.fn().mockResolvedValue([]),
    addTombstone: vi.fn().mockResolvedValue(undefined),
    removeTombstones: vi.fn().mockResolvedValue(undefined),
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

// Inert chat-sync surface — import/export never drives cloud writes for the
// anonymous user these tests run as.
vi.mock('../../libs/chat-sync', () => ({
  applyCreateActions: vi.fn().mockResolvedValue([]),
  reconcileLocalAndRemote: vi.fn().mockReturnValue({ adopt: [], claim: [], create: [] }),
  createCloudChatMapper: () => ({
    listChats: vi.fn().mockResolvedValue([]),
    deleteChat: vi.fn().mockResolvedValue(undefined),
  }),
  createChatWsClient: () => ({
    status: () => 'idle' as const,
    connect: vi.fn(),
    disconnect: vi.fn(),
    destroy: vi.fn(),
    sendMessages: vi.fn().mockResolvedValue({ ok: true }),
    pullMessages: vi.fn().mockResolvedValue({ messages: [], maxSeq: 0 }),
    onNewMessages: () => () => {},
    onStatusChange: () => () => {},
  }),
  extractMessageText: (m: any) => (typeof m?.content === 'string' ? m.content : ''),
  isCloudSyncableMessage: () => false,
  mergeCloudMessagesIntoLocal: () => ({ dirty: false, messages: [], maxSeq: 0 }),
}))

const { useChatSessionStore } = await import('./session-store')

function makeMeta(sessionId: string, userId: string, extras?: Partial<ChatSessionMeta>): ChatSessionMeta {
  return {
    sessionId,
    userId,
    characterId: 'default',
    createdAt: 1,
    updatedAt: 1,
    ...extras,
  }
}

function makeMessages(text: string): ChatHistoryItem[] {
  return [
    { role: 'user', content: text, id: `${text}-id`, createdAt: 1 } as ChatHistoryItem,
  ]
}

function makeExport(exporterUserId: string, sessionId: string, text: string, metaExtras?: Partial<ChatSessionMeta>): ChatSessionsExport {
  const meta = makeMeta(sessionId, exporterUserId, metaExtras)
  return {
    format: 'chat-sessions-index:v1',
    index: {
      userId: exporterUserId,
      characters: {
        [meta.characterId]: { activeSessionId: sessionId, sessions: { [sessionId]: meta } },
      },
    },
    sessions: {
      [sessionId]: { meta, messages: makeMessages(text) },
    },
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  userIdRef.value = 'local'
  activeCardIdRef.value = 'default'
  systemPromptRef.value = ''
  cardsRef.value = new Map()
  storedIndexes.clear()
  storedSessions.clear()
  getIndexMock.mockClear()
  saveIndexMock.mockClear()
  getSessionMock.mockClear()
  saveSessionMock.mockClear()
})

describe('chat-session-store · importSessions', () => {
  // Control case: exporter and importer are the same anonymous 'local' user.
  // This is the only path importSessions currently handles correctly; it
  // pins the baseline so the mismatch repro below isolates the userId
  // rekeying as the broken variable.
  it('restores sessions when the export was made by the same user', async () => {
    const store = useChatSessionStore()
    await store.initialize()

    await store.importSessions(makeExport('local', 'sess-imported', 'hello-from-backup'))

    expect(store.activeSessionId).toBe('sess-imported')
    expect(store.sessionMetas['sess-imported']).toBeDefined()
    // Position, not just presence: the store prepends the active card's system
    // message to whatever it loads, so the restored history sits behind it.
    expect(store.sessionMessages['sess-imported']?.filter(message => message.role !== 'system')[0]?.content).toBe('hello-from-backup')

    // Reload-visible: the current user's index bucket references the session.
    const localIndex = storedIndexes.get('local')
    expect(localIndex).toBeDefined()
    expect(localIndex!.characters.default.sessions['sess-imported']).toBeDefined()
  })

  // ROOT CAUSE:
  //
  // importSessions trusts `payload.index.userId` — the EXPORTING user's id —
  // instead of rekeying the payload to the current user.
  //
  // If the export was made while signed in (userId 'user-cloud-42') and is
  // imported while signed out (userId 'local'), or vice versa:
  //   1. `chatSessionsRepo.saveIndex(payload.index)` persists the index into
  //      the wrong per-user bucket (`local:chat/index/user-cloud-42`).
  //   2. The trailing `ensureActiveSessionForCharacter()` sees
  //      `index.value.userId !== currentUserId` and reloads the CURRENT
  //      user's bucket — the stale pre-import index — clobbering the
  //      imported index in memory.
  //   3. The UI shows the "imported" success toast, but the sessions are
  //      orphaned in the foreign bucket and invisible after reload.
  //
  // We fixed this by rekeying `index.userId` and every session meta's
  // `userId` to the current user during import, and stripping the exporter's
  // `cloudChatId` / `cloudMaxSeq` (they map to the exporter's account;
  // keeping them would let the next reconcile push this user's messages into
  // another account's cloud chat).
  it('makes sessions from another user\'s export visible to the current user', async () => {
    // Current user 'local' already has one session persisted pre-import.
    const oldMeta = makeMeta('sess-old', 'local')
    storedIndexes.set('local', {
      userId: 'local',
      characters: {
        default: { activeSessionId: 'sess-old', sessions: { 'sess-old': oldMeta } },
      },
    })
    storedSessions.set('sess-old', { meta: oldMeta, messages: makeMessages('old-local-chat') })

    const store = useChatSessionStore()
    await store.initialize()
    expect(store.activeSessionId).toBe('sess-old')

    // Import a backup exported under a signed-in account whose sessions were
    // already mirrored to that account's cloud chats.
    await store.importSessions(makeExport('user-cloud-42', 'sess-imported', 'hello-from-cloud-backup', {
      cloudChatId: 'cloud-chat-1',
      cloudMaxSeq: 7,
    }))

    // The imported session must land in the CURRENT user's index bucket,
    // otherwise it is invisible after the next reload.
    const localIndex = storedIndexes.get('local')
    expect(localIndex).toBeDefined()
    const importedMeta = localIndex!.characters.default.sessions['sess-imported']
    expect(importedMeta).toBeDefined()
    expect(importedMeta.userId).toBe('local')
    expect(importedMeta.cloudChatId).toBeUndefined()
    expect(importedMeta.cloudMaxSeq).toBeUndefined()

    // The persisted per-session record is what loadSession hydrates from
    // after a reload — its meta must be rekeyed and stripped too.
    const storedRecord = storedSessions.get('sess-imported')
    expect(storedRecord).toBeDefined()
    expect(storedRecord!.meta.userId).toBe('local')
    expect(storedRecord!.meta.cloudChatId).toBeUndefined()
    expect(storedRecord!.meta.cloudMaxSeq).toBeUndefined()

    // And the user-visible surfaces must show it right away.
    expect(store.sessionMetas['sess-imported']?.userId).toBe('local')
    const exported = await store.exportSessions()
    expect(exported.sessions['sess-imported']).toBeDefined()
    expect(store.activeSessionId).toBe('sess-imported')
  })

  // ROOT CAUSE (desktop multi-window):
  //
  // The tamagotchi app runs the settings page in its own BrowserWindow with
  // an independent Pinia instance of this store over the same IndexedDB.
  // Importing there persisted correctly, but the stage window (the chat-sync
  // authority, see apps/stage-tamagotchi/src/renderer/stores/chat-sync.ts)
  // never rereads disk: it kept broadcasting its stale in-memory snapshot to
  // follower windows, so the user saw "imported" succeed with zero visible
  // effect — and the authority's next persist would overwrite the imported
  // index on disk with the stale one.
  //
  // We fixed this by broadcasting a sessions-rewritten invalidation from the
  // importing context (BroadcastChannel, window-guarded) and having every
  // other store instance run `rehydrateFromDisk`. The channel glue cannot
  // run in the node test env, so this test drives the same flow directly:
  // window B imports, window A rehydrates, both share one mocked IDB.
  it('makes an import from one window visible to another window after rehydrateFromDisk', async () => {
    // Window A (stage/authority) hydrates first and holds pre-import state.
    const oldMeta = makeMeta('sess-old', 'local')
    storedIndexes.set('local', {
      userId: 'local',
      characters: {
        default: { activeSessionId: 'sess-old', sessions: { 'sess-old': oldMeta } },
      },
    })
    storedSessions.set('sess-old', { meta: oldMeta, messages: makeMessages('old-local-chat') })

    const piniaA = createPinia()
    setActivePinia(piniaA)
    const storeA = useChatSessionStore()
    await storeA.initialize()
    expect(storeA.activeSessionId).toBe('sess-old')

    // Window B (settings) is a separate Pinia instance over the same disk;
    // the user performs the import there.
    const piniaB = createPinia()
    setActivePinia(piniaB)
    const storeB = useChatSessionStore()
    await storeB.initialize()
    await storeB.importSessions(makeExport('local', 'sess-imported', 'hello-from-backup'))

    // Window A still shows pre-import state — this is the stale in-memory
    // view the invalidation broadcast exists to flush.
    expect(storeA.sessionMetas['sess-imported']).toBeUndefined()

    // The broadcast receiver runs rehydrateFromDisk; drive it directly.
    await storeA.rehydrateFromDisk()

    expect(storeA.activeSessionId).toBe('sess-imported')
    expect(storeA.sessionMetas['sess-imported']).toBeDefined()
    expect(storeA.sessionMessages['sess-imported']?.filter(message => message.role !== 'system')[0]?.content).toBe('hello-from-backup')
    // The stale session list must be gone from window A's memory too — the
    // import replaced the index wholesale.
    expect(storeA.sessionMetas['sess-old']).toBeUndefined()
  })

  // Production exports reference the exporting install's card ids (nanoids),
  // which do not exist on the importing install. Without re-homing, the
  // sessions sit under a card the picker never selects: the user gets a
  // fresh empty session and must dig the import out of the drawer. The
  // import re-homes such buckets onto the CURRENT card and lands on the
  // exporter's active conversation directly.
  it('re-homes sessions from a missing card onto the current card and activates the imported session', async () => {
    const store = useChatSessionStore()
    await store.initialize()
    const preImportActive = store.activeSessionId

    await store.importSessions(makeExport('user-cloud-42', 'sess-imported', 'hello-from-prod', {
      characterId: 'card-prod-1',
    }))

    // Auto-switch: no drawer interaction needed, and the pre-import fresh
    // session is not resurrected as a stray.
    expect(store.activeSessionId).toBe('sess-imported')
    expect(store.activeSessionId).not.toBe(preImportActive)
    expect(Object.keys(store.sessionMetas)).toEqual(['sess-imported'])
    expect(store.sessionMetas['sess-imported']?.characterId).toBe('default')

    const localIndex = storedIndexes.get('local')
    expect(localIndex).toBeDefined()
    expect(localIndex!.characters['card-prod-1']).toBeUndefined()
    expect(localIndex!.characters.default.sessions['sess-imported']?.characterId).toBe('default')
    expect(localIndex!.characters.default.activeSessionId).toBe('sess-imported')
    expect(storedSessions.get('sess-imported')?.meta.characterId).toBe('default')
  })

  it('keeps sessions under their card when that card exists locally', async () => {
    cardsRef.value = new Map([['card-kept', { name: 'Kept' }]])

    const store = useChatSessionStore()
    await store.initialize()

    await store.importSessions(makeExport('local', 'sess-kept', 'kept-card-chat', {
      characterId: 'card-kept',
    }))

    // Bucket and metas keep their card linkage; switching to that card
    // surfaces the imported session via the regular active-session picker.
    const localIndex = storedIndexes.get('local')
    expect(localIndex).toBeDefined()
    expect(localIndex!.characters['card-kept']?.sessions['sess-kept']?.characterId).toBe('card-kept')
    expect(localIndex!.characters['card-kept']?.activeSessionId).toBe('sess-kept')

    // The current card ('default') is not the imported card, so the stage
    // falls back to a fresh session for it — but the imported session is
    // already visible to the drawer.
    expect(store.activeSessionId).not.toBe('sess-kept')
    expect(store.sessionMetas['sess-kept']).toBeDefined()
  })
})
