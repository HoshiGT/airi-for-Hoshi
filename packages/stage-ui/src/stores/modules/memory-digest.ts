import { defineStore } from 'pinia'
import { watch } from 'vue'

import { useMemoryService } from '../chat/memory'
import { formatMemoryDigest } from '../chat/memory/digest'
import { useChatSessionStore } from '../chat/session-store'
import { useLlmToolsetPromptsStore } from '../llm-toolset-prompts'
import { useAiriCardStore } from './airi-card'
import { useMemoryStore } from './memory'

/** Toolset-prompt slot this store owns, separate from the memory module's own. */
const DIGEST_PROVIDER = 'memory-digest'

/**
 * Puts the character's most important memories into the prompt once per
 * conversation, so it starts out already knowing them instead of having to
 * guess that a `memory_recall` is worth making.
 *
 * ## Why once, and why it never refreshes mid-session
 *
 * The bridge's cost model rests on a stable prompt prefix: a conversation
 * resumes its Claude session and only the new turn goes on the wire, so the
 * prefix is cache-*read* rather than re-created. Anything injected per turn —
 * a recall keyed off the current message, say — rewrites that prefix every
 * turn and turns every message into a cache miss.
 *
 * Pinning the digest at session start keeps the prefix append-only for the life
 * of the conversation. The cost is real and deliberate: a memory saved during
 * this conversation does not enter the digest until the next one. It is still
 * reachable the whole time through `memory_recall`, which is the tool for
 * "something I learned since", so the character is not actually blind to it.
 *
 * ## Lifecycle
 *
 * Cached per session id in memory (not persisted): a restart rebuilding the
 * digest is fine, because the prefix has to be re-established after a restart
 * anyway. Scoped by character for the same reason recall is — switching cards
 * must not leak one character's memories into another's prompt.
 */
export const useMemoryDigestStore = defineStore('memory-digest', () => {
  const chatSession = useChatSessionStore()
  const memoryStore = useMemoryStore()
  const memoryService = useMemoryService()
  const cardStore = useAiriCardStore()
  const toolsetPromptsStore = useLlmToolsetPromptsStore()

  /** `${characterId}::${sessionId}` → rendered digest (`''` = nothing to say). */
  const digestByConversation = new Map<string, string>()
  /**
   * Guards against a stale build winning: the active session can change while
   * the memory query is in flight, and the late resolver must not overwrite the
   * prompt for the conversation the user has since moved to.
   */
  let buildEpoch = 0

  function conversationKeyOf(sessionId: string): string {
    const characterId = chatSession.sessionMetas[sessionId]?.characterId || cardStore.activeCardId || 'default'
    return `${characterId}::${sessionId}`
  }

  function mount(digest: string) {
    if (!digest) {
      toolsetPromptsStore.clearToolsetPrompts(DIGEST_PROVIDER)
      return
    }
    toolsetPromptsStore.registerToolsetPrompts(DIGEST_PROVIDER, [
      { id: 'memory-digest', title: 'What you remember', content: digest },
    ])
  }

  async function syncDigest() {
    if (!memoryStore.toolsActive) {
      toolsetPromptsStore.clearToolsetPrompts(DIGEST_PROVIDER)
      return
    }

    const sessionId = chatSession.activeSessionId
    if (!sessionId) {
      toolsetPromptsStore.clearToolsetPrompts(DIGEST_PROVIDER)
      return
    }

    const key = conversationKeyOf(sessionId)
    const cached = digestByConversation.get(key)
    // A cache hit is the whole point on every turn after the first: re-querying
    // would let a mid-session `memory_save` change the prefix.
    if (cached !== undefined) {
      mount(cached)
      return
    }

    const epoch = ++buildEpoch
    const characterId = key.slice(0, key.indexOf('::'))
    try {
      const items = await memoryService.listMemories({ characterId })
      const digest = formatMemoryDigest(items)
      digestByConversation.set(key, digest)
      if (epoch === buildEpoch)
        mount(digest)
    }
    catch {
      // A failed lookup must not poison the cache: leaving the key unset lets
      // the next session switch retry, and the conversation runs without the
      // digest rather than not at all.
      if (epoch === buildEpoch)
        toolsetPromptsStore.clearToolsetPrompts(DIGEST_PROVIDER)
    }
  }

  /**
   * Drop a conversation's pinned digest so the next visit rebuilds it. For the
   * settings UI after editing memories — without this, a correction would not
   * reach conversations already pinned in this process.
   */
  function invalidate(sessionId?: string) {
    if (!sessionId) {
      digestByConversation.clear()
      void syncDigest()
      return
    }
    digestByConversation.delete(conversationKeyOf(sessionId))
    void syncDigest()
  }

  watch(
    [() => chatSession.activeSessionId, () => memoryStore.toolsActive],
    () => void syncDigest(),
    { immediate: true },
  )

  return {
    invalidate,
  }
})
