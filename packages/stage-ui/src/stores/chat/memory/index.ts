import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { ConsolidationOutput } from './consolidation'
import type { MemoryExport, MemoryKind, RankedMemory, RetrieveOptions } from './repository'
import type { ConsolidationRunRow } from './schema'

import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref } from 'vue'

import { useMemoryStore } from '../../modules/memory'
import { useProvidersStore } from '../../providers'
import { runConsolidation } from './consolidation'
import { useMemoryDb } from './db'
import { LocalKeywordRetriever, MemoryRepository } from './repository'

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

  async function listMemories(filter?: { sessionId?: string, kind?: MemoryKind }) {
    return (await repository()).listMemoryItems(filter)
  }

  async function listArchives(sessionId?: string) {
    return (await repository()).listArchivedSummaries(sessionId)
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
    listArchives,
    clear,
    exportMemory,
    importMemory,
  }
})
