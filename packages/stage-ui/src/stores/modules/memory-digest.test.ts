import type { EffectScope } from 'vue'

import type { MemoryItemRow } from '../chat/memory/schema'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { useLlmToolsetPromptsStore } from '../llm-toolset-prompts'
import { useMemoryDigestStore } from './memory-digest'

interface SessionStub {
  activeSessionId: string
  sessionMetas: Record<string, { characterId: string }>
}

// NOTICE:
// The stub stores are built inside the mock factories with `reactive`, not as
// plain hoisted objects. The store under test watches `activeSessionId` through
// a getter, and a plain object gives the watcher nothing to track — switching
// conversations would silently never fire. The factories publish the reactive
// instances back onto `stubs` so the tests can drive them.
const stubs = vi.hoisted(() => ({
  listMemories: vi.fn(),
  session: null as unknown as SessionStub,
  memory: null as unknown as { toolsActive: boolean },
}))

vi.mock('../chat/memory', () => ({
  useMemoryService: () => ({ listMemories: stubs.listMemories }),
}))

vi.mock('../chat/session-store', async () => {
  const { reactive } = await import('vue')
  stubs.session = reactive<SessionStub>({ activeSessionId: 'session-1', sessionMetas: {} })
  return { useChatSessionStore: () => stubs.session }
})

vi.mock('./memory', async () => {
  const { reactive } = await import('vue')
  stubs.memory = reactive({ toolsActive: true })
  return { useMemoryStore: () => stubs.memory }
})

vi.mock('./airi-card', () => ({
  useAiriCardStore: () => ({ activeCardId: 'airi' }),
}))

function memory(content: string, importance = 0.8): MemoryItemRow {
  return {
    id: `mem-${content}`,
    characterId: 'airi',
    sessionId: 'session-1',
    kind: 'long',
    layer: 1,
    content,
    importance,
    keywords: [],
    sourceRoundFrom: null,
    sourceRoundTo: null,
    aggregatedAt: null,
    createdAt: new Date(0),
    lastAccessedAt: null,
    accessCount: 0,
  }
}

/** The watcher builds asynchronously; give the query and its `.then` a turn. */
async function settle() {
  await nextTick()
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

function mountedDigest(prompts: ReturnType<typeof useLlmToolsetPromptsStore>): string | undefined {
  return prompts.promptsByProvider['memory-digest']?.[0]?.content
}

describe('useMemoryDigestStore', () => {
  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    stubs.listMemories.mockReset()
    stubs.listMemories.mockResolvedValue([])
    stubs.session.activeSessionId = 'session-1'
    stubs.session.sessionMetas = {}
    stubs.memory.toolsActive = true
  })

  afterEach(() => {
    // NOTICE:
    // `setActivePinia` only redirects where new stores are created; it does not
    // stop the previous instance's effects. The store under test watches the
    // module-level reactive stubs, so without this the last test's watcher stays
    // subscribed and reacts to the next test's setup — which showed up as
    // queries firing against a store that no longer existed.
    // Root cause: Pinia exposes no public dispose; `_e` is its EffectScope.
    // Removal condition: drop this once Pinia ships a public teardown.
    (pinia as unknown as { _e: EffectScope })._e.stop()
  })

  it('pins the character memories into the prompt when a conversation opens', async () => {
    stubs.listMemories.mockResolvedValue([memory('Hoshi prefers concise replies.', 0.9)])
    const prompts = useLlmToolsetPromptsStore()
    useMemoryDigestStore()
    await settle()

    expect(stubs.listMemories).toHaveBeenCalledWith({ characterId: 'airi' })
    expect(mountedDigest(prompts)).toContain('Hoshi prefers concise replies.')
  })

  it('does not re-query while the conversation stays open', async () => {
    // ROOT CAUSE:
    //
    // The bridge resumes a Claude session and only sends the new turn, which is
    // only cheap while the prompt prefix is byte-stable. Rebuilding the digest
    // mid-conversation (after a `memory_save`, say) rewrites that prefix and
    // turns every later turn into a cache miss.
    //
    // The digest is therefore pinned per conversation and served from cache.
    stubs.listMemories.mockResolvedValue([memory('pinned fact')])
    useMemoryDigestStore()
    await settle()

    // A later save changes what the query would return; the prompt must not move.
    stubs.listMemories.mockResolvedValue([memory('pinned fact'), memory('brand new fact')])
    stubs.session.activeSessionId = 'session-2'
    await settle()
    stubs.session.activeSessionId = 'session-1'
    await settle()

    const prompts = useLlmToolsetPromptsStore()
    expect(mountedDigest(prompts)).toContain('pinned fact')
    expect(mountedDigest(prompts)).not.toContain('brand new fact')
  })

  it('builds a fresh digest for a conversation it has not seen', async () => {
    stubs.listMemories.mockResolvedValue([memory('first')])
    useMemoryDigestStore()
    await settle()

    stubs.listMemories.mockResolvedValue([memory('second')])
    stubs.session.activeSessionId = 'session-2'
    await settle()

    expect(mountedDigest(useLlmToolsetPromptsStore())).toContain('second')
  })

  it('scopes the query to the session own character, not just the active card', async () => {
    stubs.session.sessionMetas = { 'session-1': { characterId: 'char-42' } }
    useMemoryDigestStore()
    await settle()

    expect(stubs.listMemories).toHaveBeenCalledWith({ characterId: 'char-42' })
  })

  it('mounts nothing when the character has no memories yet', async () => {
    stubs.listMemories.mockResolvedValue([])
    const prompts = useLlmToolsetPromptsStore()
    useMemoryDigestStore()
    await settle()

    expect(prompts.promptsByProvider['memory-digest']).toBeUndefined()
  })

  it('stays out of the prompt entirely while the memory module is inactive', async () => {
    stubs.memory.toolsActive = false
    const prompts = useLlmToolsetPromptsStore()
    useMemoryDigestStore()
    await settle()

    expect(stubs.listMemories).not.toHaveBeenCalled()
    expect(prompts.promptsByProvider['memory-digest']).toBeUndefined()
  })

  it('runs the conversation without a digest when the lookup fails', async () => {
    stubs.listMemories.mockRejectedValue(new Error('database unavailable'))
    const prompts = useLlmToolsetPromptsStore()
    useMemoryDigestStore()
    await settle()

    expect(prompts.promptsByProvider['memory-digest']).toBeUndefined()

    // The failure must not be cached as "this conversation has no memories".
    stubs.listMemories.mockResolvedValue([memory('recovered fact')])
    stubs.session.activeSessionId = 'session-2'
    await settle()
    stubs.session.activeSessionId = 'session-1'
    await settle()

    expect(mountedDigest(prompts)).toContain('recovered fact')
  })

  it('rebuilds a conversation digest when invalidated after a memory edit', async () => {
    stubs.listMemories.mockResolvedValue([memory('stale fact')])
    const store = useMemoryDigestStore()
    const prompts = useLlmToolsetPromptsStore()
    await settle()

    stubs.listMemories.mockResolvedValue([memory('corrected fact')])
    store.invalidate('session-1')
    await settle()

    expect(mountedDigest(prompts)).toContain('corrected fact')
  })
})
