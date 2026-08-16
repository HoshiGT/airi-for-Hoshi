import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { ChatHistoryItem } from '../../../types/chat'
import type { ConsolidationOutput } from './consolidation'
import type { MemoryExport, MemoryKind, RankedMemory, RetrieveOptions } from './repository'
import type { ConsolidationRunRow, MemoryItemRow, NewMemoryItem } from './schema'

import { errorMessageFrom } from '@moeru/std'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref } from 'vue'

import { useMemoryStore } from '../../modules/memory'
import { useProvidersStore } from '../../providers'
import { runConsolidation } from './consolidation'
import { useMemoryDb } from './db'
import { runLayerOnePass, runLayerThreePass, runLayerTwoPass } from './layered-consolidation'
import { initialLayerState, planLayerPass, stateAfterL1Pass } from './layers'
import { LocalKeywordRetriever, MemoryRepository } from './repository'
import { splitRounds, toProviderHistory } from './trim'

/**
 * Normalizes user-supplied recall tags to match the consolidation model's
 * format (lowercased topic words), deduped and stripped of blanks.
 *
 * Before:
 * - ["QQ", " qq ", "表情包", ""]
 *
 * After:
 * - ["qq", "表情包"]
 */
function normalizeKeywords(keywords: string[]): string[] {
  return [...new Set(keywords.map(keyword => keyword.trim().toLowerCase()).filter(Boolean))]
}

export type { ConsolidationOutput } from './consolidation'
export type { MemoryExport, MemoryKind, RankedMemory } from './repository'
export type { ConsolidationRunRow } from './schema'

// User-defined undo depth: the last two consolidation passes per session stay
// reversible; older backups are pruned (their memories/summaries stay, they
// just can no longer be undone).
const UNDOABLE_RUNS_KEPT = 2

/**
 * Runtime engine for the memory feature: owns the PGlite-backed repository and
 * the active retriever, and exposes the high-level operations the chat flow,
 * the recall tool, and the settings UI build on.
 *
 * Kept separate from {@link useMemoryStore} (which only holds model selection
 * and cadence config) so the persistent-DB lifecycle doesn't bloat the settings
 * store. The {@link MemoryRetriever} is swappable here — Phase 3 replaces
 * {@link LocalKeywordRetriever} with a semantic one without touching callers.
 */
export const useMemoryService = defineStore('memory-service', () => {
  const memoryStore = useMemoryStore()
  const providersStore = useProvidersStore()
  const { triggerRounds, retainRounds } = storeToRefs(memoryStore)

  const { getDb } = useMemoryDb()

  let repositoryPromise: Promise<MemoryRepository> | null = null
  const lastConsolidation = ref<ConsolidationOutput | null>(null)
  const consolidating = ref(false)

  // Single-flight repository init: every op funnels through this so the DB opens
  // exactly once and concurrent callers share the same connection.
  function repository(): Promise<MemoryRepository> {
    if (!repositoryPromise) {
      repositoryPromise = getDb().then(db => new MemoryRepository(db))
    }
    return repositoryPromise
  }

  async function retriever() {
    return new LocalKeywordRetriever(await repository())
  }

  /**
   * Whether a consolidation pass is due.
   *
   * True once the live round count reaches the high-water mark; the caller then
   * trims everything older than {@link retainRounds} via {@link consolidate}.
   */
  function shouldConsolidate(roundCount: number): boolean {
    return memoryStore.configured && roundCount >= triggerRounds.value
  }

  /** How many of the oldest rounds a pass should trim, given the live count. */
  function overflowCount(roundCount: number): number {
    return Math.max(0, roundCount - retainRounds.value)
  }

  /**
   * Summarize+classify+persist the supplied (oldest) rounds.
   *
   * Resolves the memory model on demand, so a missing/unconfigured model surfaces
   * as a thrown error the caller can decide to swallow (keeping live history
   * intact) rather than silently dropping memories.
   *
   * When `options.archivedSessionMessages` is provided (the live-session items
   * the caller is about to trim, ids included), the pass also records an undo
   * backup; only the {@link UNDOABLE_RUNS_KEPT} most recent backups per session
   * are retained.
   */
  async function consolidate(
    characterId: string,
    sessionId: string,
    messages: Message[],
    options?: { roundFrom?: number, roundTo?: number, archivedSessionMessages?: unknown[] },
  ): Promise<ConsolidationOutput> {
    if (!memoryStore.configured)
      throw new Error('Memory model is not configured')

    consolidating.value = true
    try {
      const provider = await providersStore.getProviderInstance<ChatProvider>(memoryStore.activeProvider)
      const repo = await repository()
      const record = await runConsolidation({
        provider,
        model: memoryStore.resolvedModel,
        characterId,
        sessionId,
        messages,
        roundFrom: options?.roundFrom,
        roundTo: options?.roundTo,
        guidance: memoryStore.consolidationPrompt,
        repository: repo,
      })

      if (options?.archivedSessionMessages) {
        await repo.addConsolidationRun({
          id: nanoid(),
          characterId,
          sessionId,
          archivedMessages: options.archivedSessionMessages,
          memoryIds: record.memoryIds,
          archiveId: record.archiveId,
          roundFrom: options?.roundFrom,
          roundTo: options?.roundTo,
        })
        await repo.pruneConsolidationRuns(sessionId, UNDOABLE_RUNS_KEPT)
      }

      lastConsolidation.value = record
      return record
    }
    finally {
      consolidating.value = false
    }
  }

  /**
   * Reverse the most recent consolidation pass of a session (LIFO).
   *
   * Cascades the DB side only: deletes the memories and archived summary that
   * pass created plus its backup row, then returns the backup so the caller can
   * splice the trimmed messages back into the live session. Returns `null` when
   * no undoable pass remains. The DB cascade runs first so the run stack and
   * memory list stay consistent even if the caller's restore is interrupted —
   * the restore payload is already in the returned row.
   */
  async function undoLastConsolidation(sessionId: string): Promise<ConsolidationRunRow | null> {
    const repo = await repository()
    const run = await repo.latestConsolidationRun(sessionId)
    if (!run)
      return null

    await repo.removeMemoryItems(run.memoryIds)
    await repo.removeArchivedSummary(run.archiveId)
    await repo.deleteConsolidationRun(run.id)
    return run
  }

  /** How many consolidation passes of this session can still be undone. */
  async function undoableConsolidationCount(sessionId: string): Promise<number> {
    return (await repository()).countConsolidationRuns(sessionId)
  }

  async function recall(query: string, options?: RetrieveOptions): Promise<RankedMemory[]> {
    return (await retriever()).search(query, options)
  }

  async function listMemories(filter?: { characterId?: string, sessionId?: string, kind?: MemoryKind }) {
    return (await repository()).listMemoryItems(filter)
  }

  async function removeMemory(id: string): Promise<void> {
    await (await repository()).removeMemoryItems([id])
  }

  /**
   * Add a memory the user wrote or salvaged in the settings UI, for reviewing
   * consolidation output. Recall tags are user-supplied (normalized to the
   * model's lowercased-topic format); left empty, recall falls back to matching
   * the content itself. Kind/importance default to a neutral long-term fact.
   */
  async function addMemory(input: {
    characterId: string
    content: string
    kind?: MemoryKind
    importance?: number
    keywords?: string[]
    sessionId?: string
  }): Promise<void> {
    const item: NewMemoryItem = {
      id: nanoid(),
      characterId: input.characterId,
      // Manual entries aren't distilled from a conversation; a sentinel session
      // keeps them grouped and clear of session-scoped undo/clear paths.
      sessionId: input.sessionId ?? 'manual',
      kind: input.kind ?? 'long',
      content: input.content,
      importance: input.importance ?? 0.5,
      keywords: normalizeKeywords(input.keywords ?? []),
    }
    await (await repository()).addMemoryItems([item])
  }

  /**
   * Edit a stored memory in place (manual review/correction). Every field is
   * patched only when provided; `keywords` are the user's edited tags — kept
   * verbatim (normalized), never re-tokenized, so a curated tag list survives a
   * content fix instead of exploding into per-character tokens.
   */
  async function updateMemory(id: string, patch: { content?: string, kind?: MemoryKind, importance?: number, keywords?: string[] }): Promise<void> {
    const fields: Partial<Pick<MemoryItemRow, 'content' | 'kind' | 'importance' | 'keywords'>> = {}
    if (patch.content !== undefined)
      fields.content = patch.content
    if (patch.kind !== undefined)
      fields.kind = patch.kind
    if (patch.importance !== undefined)
      fields.importance = patch.importance
    if (patch.keywords !== undefined)
      fields.keywords = normalizeKeywords(patch.keywords)
    await (await repository()).updateMemoryItem(id, fields)
  }

  async function listArchives(filter?: { characterId?: string, sessionId?: string }) {
    return (await repository()).listArchivedSummaries(filter)
  }

  /**
   * How far this session has already been summarized, as a 1-based round number
   * (0 = never consolidated).
   *
   * Callers pass this into `planConsolidation` so a pass that leaves the archived
   * rounds in the live context does not distill them again on the next run.
   */
  async function consolidatedThroughRound(sessionId: string): Promise<number> {
    return (await repository()).latestArchivedRound(sessionId)
  }

  // Sessions with an in-flight layered pass. Separate from the classic
  // consolidation guard in the chat store on purpose: the chat store chains
  // `layeredTick` behind `maybeConsolidateSession`, and this guard protects the
  // layered path itself against re-entry from overlapping turns.
  const layeredTicking = new Set<string>()

  /**
   * Advance the layered consolidation schedule (L1 → L2 → L3) after a turn.
   *
   * Hook-driven rather than timer-driven: the chat orchestrator calls this once
   * per completed reply, so idle sessions produce no work — the "cold session
   * stops polling" behavior falls out of having no timer at all. At most one
   * model call runs per invocation (see {@link planLayerPass}).
   *
   * Non-destructive: L1 distills rounds into facts but never trims them from
   * the live context; trimming stays with the classic daily consolidation path.
   * Failures are swallowed so a broken model config can never disturb chat.
   */
  async function layeredTick(characterId: string, sessionId: string, messages: ChatHistoryItem[]): Promise<void> {
    if (!memoryStore.configured)
      return
    if (!memoryStore.layeredConsolidationEnabled)
      return
    if (layeredTicking.has(sessionId))
      return

    layeredTicking.add(sessionId)
    try {
      const repo = await repository()
      const { rounds } = splitRounds(messages)
      const state = (await repo.getLayerState(characterId, sessionId)) ?? initialLayerState()

      // Round numbering is positional; when history was trimmed since the last
      // pass the watermark would point past the end. Re-anchor it to the current
      // count — the trimmed rounds were already archived by the daily pass.
      const anchoredState = rounds.length < state.l1RoundsProcessed
        ? { ...state, l1RoundsProcessed: rounds.length }
        : state

      const counts = {
        l1Pending: await repo.countPendingLayerItems(1, { characterId, sessionId }),
        l2Pending: await repo.countPendingLayerItems(2, { characterId }),
      }

      const action = planLayerPass({
        ...anchoredState,
        roundCount: rounds.length,
        counts,
      })

      if (action.type === 'none') {
        // Persist only when the anchor moved, so the reset survives a reload.
        if (anchoredState.l1RoundsProcessed !== state.l1RoundsProcessed) {
          await repo.upsertLayerState({
            characterId,
            sessionId,
            ...anchoredState,
          })
        }
        return
      }

      const provider = await providersStore.getProviderInstance<ChatProvider>(memoryStore.activeProvider)
      const model = memoryStore.resolvedModel

      if (action.type === 'l1') {
        const distilled = rounds.slice(action.roundFrom - 1, action.roundTo).flat()
        if (distilled.length === 0)
          return

        await runLayerOnePass({
          provider,
          model,
          characterId,
          sessionId,
          messages: toProviderHistory(distilled),
          roundFrom: action.roundFrom,
          roundTo: action.roundTo,
          repository: repo,
        })
        await repo.upsertLayerState({
          characterId,
          sessionId,
          ...stateAfterL1Pass(anchoredState, action.roundTo),
        })
        return
      }

      if (action.type === 'l2') {
        await runLayerTwoPass({ provider, model, characterId, sessionId, repository: repo })
        return
      }

      await runLayerThreePass({ provider, model, characterId, sessionId, repository: repo })
    }
    catch (error) {
      console.warn('[memory] layered consolidation failed for', sessionId, errorMessageFrom(error))
    }
    finally {
      layeredTicking.delete(sessionId)
    }
  }

  async function clear(sessionId?: string) {
    await (await repository()).clear(sessionId)
  }

  /** Dump all memory tables for the chat backup file (JSON-safe rows). */
  async function exportMemory(): Promise<MemoryExport> {
    return (await repository()).exportAll()
  }

  /** Merge a backup's memory section; already-present rows are skipped. */
  async function importMemory(payload: MemoryExport): Promise<void> {
    await (await repository()).importAll(payload)
  }

  return {
    consolidating,
    lastConsolidation,
    shouldConsolidate,
    overflowCount,
    consolidate,
    undoLastConsolidation,
    undoableConsolidationCount,
    recall,
    listMemories,
    removeMemory,
    addMemory,
    updateMemory,
    listArchives,
    consolidatedThroughRound,
    layeredTick,
    clear,
    exportMemory,
    importMemory,
  }
})
