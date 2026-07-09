import type { MemoryDatabase } from './db'
import type { ArchivedSummaryRow, ConsolidationRunRow, MemoryItemRow, NewArchivedSummary, NewConsolidationRun, NewMemoryItem } from './schema'

import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm'

import { archivedSummaries, consolidationRuns, memoryItems } from './schema'

/** Long-term vs short-term memory bucket. */
export type MemoryKind = 'long' | 'short'

/**
 * JSON-safe projection of a drizzle row: Date columns become ISO-8601 strings.
 *
 * @param T the drizzle `$inferSelect` row type being serialized
 */
export type SerializedRow<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K]
}

/**
 * Full dump of the memory tables, bundled into the chat backup file as the
 * `ChatSessionsExport.memory` section.
 *
 * Consolidation runs (undo backups) are included so undo-last-consolidation
 * keeps working after a migration, not just the distilled memories themselves.
 */
export interface MemoryExport {
  memoryItems: SerializedRow<MemoryItemRow>[]
  archivedSummaries: SerializedRow<ArchivedSummaryRow>[]
  consolidationRuns: SerializedRow<ConsolidationRunRow>[]
}

function serializeRow<T extends object>(row: T): SerializedRow<T> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]),
  ) as SerializedRow<T>
}

/** A memory plus the relevance score a retriever assigned for a query. */
export interface RankedMemory {
  item: MemoryItemRow
  /** Retriever-defined relevance; higher is more relevant. Not normalized. */
  score: number
}

export interface RetrieveOptions {
  sessionId?: string
  kind?: MemoryKind
  /** @default 8 */
  limit?: number
}

/**
 * Pluggable recall backend.
 *
 * Phase 1 ships {@link LocalKeywordRetriever} (keyword/frequency over the local
 * PGlite store). The interface exists so Phase 3 can drop in a pgvector semantic
 * retriever — or a server-backed one — without touching callers (the recall
 * tool, context injection).
 */
export interface MemoryRetriever {
  search: (query: string, options?: RetrieveOptions) => Promise<RankedMemory[]>
}

/**
 * CRUD boundary over the browser memory tables.
 *
 * Owns all SQL touching `memory_items` / `archived_summaries` so the
 * consolidation pipeline and retrievers never assemble queries themselves.
 */
export class MemoryRepository {
  constructor(private readonly db: MemoryDatabase) {}

  async addMemoryItems(items: NewMemoryItem[]): Promise<void> {
    if (items.length === 0)
      return
    await this.db.insert(memoryItems).values(items)
  }

  async addArchivedSummary(summary: NewArchivedSummary): Promise<void> {
    await this.db.insert(archivedSummaries).values(summary)
  }

  async listMemoryItems(filter?: { sessionId?: string, kind?: MemoryKind }): Promise<MemoryItemRow[]> {
    const conditions = []
    if (filter?.sessionId)
      conditions.push(eq(memoryItems.sessionId, filter.sessionId))
    if (filter?.kind)
      conditions.push(eq(memoryItems.kind, filter.kind))

    const where = conditions.length > 0 ? and(...conditions) : undefined
    return this.db
      .select()
      .from(memoryItems)
      .where(where)
      .orderBy(desc(memoryItems.importance), desc(memoryItems.createdAt))
  }

  async listArchivedSummaries(sessionId?: string): Promise<ArchivedSummaryRow[]> {
    const where = sessionId ? eq(archivedSummaries.sessionId, sessionId) : undefined
    return this.db
      .select()
      .from(archivedSummaries)
      .where(where)
      .orderBy(desc(archivedSummaries.createdAt))
  }

  /**
   * Mark items as recalled: bump access count and refresh last-accessed time.
   * Retrievers call this after surfacing results so ranking can reward
   * repeatedly-useful memories later.
   */
  async recordAccess(ids: string[]): Promise<void> {
    if (ids.length === 0)
      return
    await this.db
      .update(memoryItems)
      .set({
        accessCount: sql`${memoryItems.accessCount} + 1`,
        lastAccessedAt: new Date(),
      })
      .where(inArray(memoryItems.id, ids))
  }

  async removeMemoryItems(ids: string[]): Promise<void> {
    if (ids.length === 0)
      return
    await this.db.delete(memoryItems).where(inArray(memoryItems.id, ids))
  }

  async removeArchivedSummary(id: string): Promise<void> {
    await this.db.delete(archivedSummaries).where(eq(archivedSummaries.id, id))
  }

  async addConsolidationRun(run: NewConsolidationRun): Promise<void> {
    await this.db.insert(consolidationRuns).values(run)
  }

  /** The most recent pass for a session — the only one undo may target (LIFO). */
  async latestConsolidationRun(sessionId: string): Promise<ConsolidationRunRow | undefined> {
    const rows = await this.db
      .select()
      .from(consolidationRuns)
      .where(eq(consolidationRuns.sessionId, sessionId))
      .orderBy(desc(consolidationRuns.seq))
      .limit(1)
    return rows[0]
  }

  async countConsolidationRuns(sessionId: string): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(consolidationRuns)
      .where(eq(consolidationRuns.sessionId, sessionId))
    return rows[0]?.count ?? 0
  }

  async deleteConsolidationRun(id: string): Promise<void> {
    await this.db.delete(consolidationRuns).where(eq(consolidationRuns.id, id))
  }

  /**
   * Drop undo backups beyond the `keep` most recent passes for a session.
   * Only the backup rows go — the memories and archived summaries those older
   * passes produced stay; they merely stop being undoable.
   */
  async pruneConsolidationRuns(sessionId: string, keep: number): Promise<void> {
    const keepRows = await this.db
      .select({ id: consolidationRuns.id })
      .from(consolidationRuns)
      .where(eq(consolidationRuns.sessionId, sessionId))
      .orderBy(desc(consolidationRuns.seq))
      .limit(keep)
    // `notInArray` with an empty list is rejected by drizzle; with no rows to
    // keep there is nothing to prune around, so clear the session's runs.
    if (keepRows.length === 0) {
      await this.db.delete(consolidationRuns).where(eq(consolidationRuns.sessionId, sessionId))
      return
    }
    await this.db
      .delete(consolidationRuns)
      .where(and(
        eq(consolidationRuns.sessionId, sessionId),
        notInArray(consolidationRuns.id, keepRows.map(row => row.id)),
      ))
  }

  /**
   * Dump every memory table for the chat backup file. Rows come out JSON-safe
   * (dates as ISO strings); {@link importAll} is the inverse.
   */
  async exportAll(): Promise<MemoryExport> {
    const [items, archives, runs] = await Promise.all([
      this.db.select().from(memoryItems).orderBy(memoryItems.createdAt),
      this.db.select().from(archivedSummaries).orderBy(archivedSummaries.createdAt),
      this.db.select().from(consolidationRuns).orderBy(consolidationRuns.seq),
    ])
    return {
      memoryItems: items.map(serializeRow),
      archivedSummaries: archives.map(serializeRow),
      consolidationRuns: runs.map(serializeRow),
    }
  }

  /**
   * Merge a {@link MemoryExport} into this database. Rows whose id already
   * exists are skipped, so re-importing the same backup never duplicates or
   * overwrites — ids are nanoids, a collision means "same row, already here".
   */
  async importAll(payload: MemoryExport): Promise<void> {
    if (payload.memoryItems.length > 0) {
      await this.db
        .insert(memoryItems)
        .values(payload.memoryItems.map(row => ({
          ...row,
          createdAt: new Date(row.createdAt),
          lastAccessedAt: row.lastAccessedAt ? new Date(row.lastAccessedAt) : null,
        })))
        .onConflictDoNothing()
    }

    if (payload.archivedSummaries.length > 0) {
      await this.db
        .insert(archivedSummaries)
        .values(payload.archivedSummaries.map(row => ({
          ...row,
          createdAt: new Date(row.createdAt),
        })))
        .onConflictDoNothing()
    }

    if (payload.consolidationRuns.length > 0) {
      // `seq` is a per-database serial, so the exported values cannot be
      // reused — re-issue serials by inserting in exported-seq order, which
      // preserves the LIFO undo order among the imported runs. If this
      // database already holds runs for the same session, the imported ones
      // land "newer" by seq regardless of their createdAt; acceptable, since
      // that only happens when re-importing into a non-fresh install.
      const orderedRuns = [...payload.consolidationRuns].sort((a, b) => a.seq - b.seq)
      await this.db
        .insert(consolidationRuns)
        .values(orderedRuns.map(({ seq: _seq, ...row }) => ({
          ...row,
          createdAt: new Date(row.createdAt),
        })))
        .onConflictDoNothing()
    }
  }

  async clear(sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.db.delete(memoryItems).where(eq(memoryItems.sessionId, sessionId))
      await this.db.delete(archivedSummaries).where(eq(archivedSummaries.sessionId, sessionId))
      await this.db.delete(consolidationRuns).where(eq(consolidationRuns.sessionId, sessionId))
      return
    }
    await this.db.delete(memoryItems)
    await this.db.delete(archivedSummaries)
    await this.db.delete(consolidationRuns)
  }
}

/**
 * Splits text into lowercased word/CJK tokens for the keyword retriever.
 *
 * Before:
 * - "Remember Hoshi's QQ 群 settings"
 *
 * After:
 * - ["remember", "hoshi", "s", "qq", "群", "settings"]
 *
 * CJK has no word boundaries, so each Han character becomes its own token; this
 * keeps single-character overlap matching cheap and language-agnostic.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.toLowerCase().matchAll(/[a-z0-9]+|[\u4E00-\u9FFF]/g))
    tokens.push(match[0])
  return tokens
}

/**
 * Local recall over the PGlite store, scoring by keyword overlap weighted by
 * each memory's model-judged importance.
 *
 * Deliberately simple and deterministic: it cannot match paraphrases the way a
 * semantic retriever would, which is the tradeoff the "local now, vector later"
 * decision accepts. Implements {@link MemoryRetriever} so it is swappable.
 */
export class LocalKeywordRetriever implements MemoryRetriever {
  constructor(private readonly repository: MemoryRepository) {}

  async search(query: string, options?: RetrieveOptions): Promise<RankedMemory[]> {
    const queryTokens = new Set(tokenize(query))
    if (queryTokens.size === 0)
      return []

    const limit = options?.limit ?? 8
    const candidates = await this.repository.listMemoryItems({
      sessionId: options?.sessionId,
      kind: options?.kind,
    })

    const ranked: RankedMemory[] = []
    for (const item of candidates) {
      // Match against stored keywords first, then fall back to the content so
      // memories whose keyword extraction was sparse can still surface.
      const haystack = item.keywords.length > 0 ? item.keywords : tokenize(item.content)
      let overlap = 0
      for (const token of haystack) {
        if (queryTokens.has(token))
          overlap += 1
      }
      if (overlap === 0)
        continue

      // Importance scales overlap so a strongly-weighted memory outranks a
      // trivially-mentioned one with the same number of matched keywords.
      const score = overlap * (0.5 + item.importance)
      ranked.push({ item, score })
    }

    ranked.sort((a, b) => b.score - a.score)
    const top = ranked.slice(0, limit)
    await this.repository.recordAccess(top.map(r => r.item.id))
    return top
  }
}
