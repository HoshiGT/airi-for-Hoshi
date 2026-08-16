import type { ChatHistoryItem } from '../../types/chat'

import { defineStore } from 'pinia'
import { toRaw } from 'vue'

import { toProviderHistory, useChatOrchestratorStore } from '../chat'
import { useAiriCardStore } from '../modules/airi-card'
import { useMemoryStore } from '../modules/memory'
import { useChatContextStore } from './context-store'
import { useMemoryService } from './memory'
import { planConsolidation } from './memory/trim'
import { useChatSessionStore } from './session-store'
import { useChatStreamStore } from './stream-store'

/**
 * Outcome of a user-triggered "consolidate now" pass. Failures from the
 * summarization model are NOT mapped here — they throw, so the UI can show
 * the actual error while live history stays untouched.
 */
export type ManualConsolidationResult
  = | { status: 'not-configured' }
    | { status: 'busy' }
    | { status: 'nothing-to-archive' }
    | { status: 'done', archivedRounds: number, memoryCount: number }

/** Outcome of undoing the most recent consolidation pass. */
export type ConsolidationUndoResult
  = | { status: 'busy' }
    | { status: 'nothing-to-undo' }
    | { status: 'done', restoredRounds: number, remainingUndoable: number }

export const useChatMaintenanceStore = defineStore('chat-maintenance', () => {
  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const chatOrchestrator = useChatOrchestratorStore()
  const cardStore = useAiriCardStore()
  const memoryStore = useMemoryStore()
  const memoryService = useMemoryService()

  function cleanupMessages(sessionId = chatSession.activeSessionId) {
    chatSession.cleanupMessages(sessionId)
    chatContext.resetContexts()
    chatOrchestrator.cancelPendingSends(sessionId)
    chatStream.resetStream()
  }

  /**
   * User-triggered consolidation: distill everything older than the configured
   * retained window RIGHT NOW, ignoring the `triggerRounds` high-water mark the
   * automatic pass waits for.
   *
   * Whether the summarized rounds also leave the conversation is the user's
   * `trimAfterConsolidation` choice; with it off this is purely additive (new
   * memories and an archived summary, chat untouched) and safe to repeat, because
   * the pass starts after the last round already summarized.
   *
   * Same safety contract as the automatic pass in the chat orchestrator:
   * live history is trimmed only after the model call and the memory-DB
   * writes succeed, and trimming is id-based so messages that arrive while
   * the model runs keep their place. Ends with a cross-window notify so a
   * stage window shows the trimmed session immediately when the button was
   * clicked in the desktop settings window.
   */
  async function consolidateSessionNow(sessionId?: string): Promise<ManualConsolidationResult> {
    if (!memoryStore.configured)
      return { status: 'not-configured' }
    if (memoryService.consolidating)
      return { status: 'busy' }

    // The settings window has its own store instance: hydrate the index and
    // active session before resolving the default target, then make sure the
    // target session's messages are actually in memory.
    await chatSession.initialize()
    const targetSessionId = sessionId ?? chatSession.activeSessionId
    if (!targetSessionId)
      return { status: 'nothing-to-archive' }
    await chatSession.loadSession(targetSessionId)

    const trimming = memoryStore.trimAfterConsolidation

    // Detach from the reactive proxy: the archived messages are persisted into
    // the memory DB and handed to the model, so they must be plain snapshots.
    const snapshot = chatSession.getSessionMessages(targetSessionId).map(message => toRaw(message))
    const plan = planConsolidation(snapshot, {
      retainRounds: memoryStore.retainRounds,
      // Without trimming the rounds stay put, so the watermark is what keeps a
      // second click from summarizing the same conversation again.
      consolidatedThroughRound: trimming ? 0 : await memoryService.consolidatedThroughRound(targetSessionId),
    })
    if (!plan)
      return { status: 'nothing-to-archive' }

    const characterId = chatSession.sessionMetas[targetSessionId]?.characterId || cardStore.activeCardId || 'default'
    const output = await memoryService.consolidate(characterId, targetSessionId, toProviderHistory(plan.archived), {
      roundFrom: plan.roundFrom,
      roundTo: plan.roundTo,
      // Undo backup: the raw session items (ids included) about to be trimmed.
      // Omitted when nothing is removed — undo then only drops the memories.
      ...(trimming ? { archivedSessionMessages: plan.archived } : {}),
    })

    if (trimming) {
      // Trim by id against the *current* list, not the snapshot: messages that
      // arrived while the model call ran keep their place; only the archived
      // rounds are removed.
      const current = chatSession.getSessionMessages(targetSessionId)
      const trimmed = current.filter(message => !message.id || !plan.archivedIds.has(message.id))
      chatSession.setSessionMessages(targetSessionId, trimmed)
      await chatSession.notifySessionsRewritten()
    }

    return {
      status: 'done',
      archivedRounds: plan.roundTo - plan.roundFrom + 1,
      memoryCount: output.items.length,
    }
  }

  /**
   * Undo the most recent consolidation pass of a session: delete the memories
   * and archived summary it produced, then splice the trimmed messages back
   * into the live history right after the leading system head — which is where
   * they sat before the trim, since any earlier-archived rounds are no longer
   * in the live list. Messages that arrived after the pass keep their place.
   *
   * Restoration dedupes by message id, so a partially-failed earlier undo (DB
   * rows already gone, messages already restored) cannot double-insert.
   */
  async function undoLastConsolidation(sessionId?: string): Promise<ConsolidationUndoResult> {
    if (memoryService.consolidating)
      return { status: 'busy' }

    await chatSession.initialize()
    const targetSessionId = sessionId ?? chatSession.activeSessionId
    if (!targetSessionId)
      return { status: 'nothing-to-undo' }
    await chatSession.loadSession(targetSessionId)

    const run = await memoryService.undoLastConsolidation(targetSessionId)
    if (!run)
      return { status: 'nothing-to-undo' }

    const current = chatSession.getSessionMessages(targetSessionId)
    const liveIds = new Set(current.map(message => message.id).filter(Boolean))
    const restored = (run.archivedMessages as ChatHistoryItem[])
      .filter(message => !message.id || !liveIds.has(message.id))

    const headLength = current.findIndex(message => message.role !== 'system')
    const insertAt = headLength === -1 ? current.length : headLength
    chatSession.setSessionMessages(targetSessionId, [
      ...current.slice(0, insertAt),
      ...restored,
      ...current.slice(insertAt),
    ])
    await chatSession.notifySessionsRewritten()

    // Round range comes from the recorded pass; fall back to counting restored
    // user turns for passes recorded without a range (the columns are nullable).
    const restoredRounds = run.roundFrom != null && run.roundTo != null
      ? run.roundTo - run.roundFrom + 1
      : restored.filter(message => message.role === 'user').length

    return {
      status: 'done',
      restoredRounds,
      remainingUndoable: await memoryService.undoableConsolidationCount(targetSessionId),
    }
  }

  /** How many consolidation passes of the target session can still be undone. */
  async function undoableConsolidationCount(sessionId?: string): Promise<number> {
    await chatSession.initialize()
    const targetSessionId = sessionId ?? chatSession.activeSessionId
    if (!targetSessionId)
      return 0
    return memoryService.undoableConsolidationCount(targetSessionId)
  }

  return {
    cleanupMessages,
    consolidateSessionNow,
    undoLastConsolidation,
    undoableConsolidationCount,
  }
})
