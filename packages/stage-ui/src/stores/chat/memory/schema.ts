import { integer, jsonb, pgTable, real, serial, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Browser-side memory schema (PGlite + drizzle).
 *
 * Uses `pg-core` so the same definitions stay portable to a server-side
 * Postgres/pgvector deployment (`packages/memory-pgvector`) without a rewrite.
 * A `vector` embedding column is intentionally NOT defined yet — local keyword
 * retrieval (Phase 1) does not need it; Phase 3 adds it via migration when the
 * retriever swaps to semantic search.
 */

/** A consolidated, classified fact distilled from trimmed conversation rounds. */
export const memoryItems = pgTable('memory_items', {
  id: text('id').primaryKey(),
  /** Character card this memory belongs to; scopes recall and listing. */
  characterId: text('character_id').notNull().default('default'),
  /** Conversation/session this memory was distilled from (e.g. `qq-private-123`). */
  sessionId: text('session_id').notNull(),
  /** Long-term vs short-term bucket, assigned by the summarization model. */
  kind: text('kind').notNull(),
  /** The memory text itself (a single distilled fact, not the raw transcript). */
  content: text('content').notNull(),
  /** Model-judged importance in [0, 1]; drives ranking and retention pressure. */
  importance: real('importance').notNull(),
  /** Lowercased keywords/entities for the local frequency retriever. */
  keywords: jsonb('keywords').$type<string[]>().notNull().default([]),
  /** Inclusive round range (1-based) in the source conversation this came from. */
  sourceRoundFrom: integer('source_round_from'),
  sourceRoundTo: integer('source_round_to'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  /** Last time a recall surfaced this item; null until first recalled. */
  lastAccessedAt: timestamp('last_accessed_at'),
  /** How many times this item has been recalled; informs future ranking. */
  accessCount: integer('access_count').notNull().default(0),
})

/**
 * The condensed summary of a consolidation pass, kept verbatim alongside the
 * raw rounds it replaced so the agent can drill back into archived history.
 */
export const archivedSummaries = pgTable('archived_summaries', {
  id: text('id').primaryKey(),
  /** Character card this archive belongs to. */
  characterId: text('character_id').notNull().default('default'),
  sessionId: text('session_id').notNull(),
  /** Narrative summary the model produced for the trimmed rounds. */
  summary: text('summary').notNull(),
  /** The original messages that were trimmed, retained for drill-back. */
  rawMessages: jsonb('raw_messages').$type<unknown[]>().notNull().default([]),
  roundFrom: integer('round_from'),
  roundTo: integer('round_to'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

/**
 * Undo backup for one consolidation pass.
 *
 * Rows exist only to make a pass reversible: undo restores
 * {@link consolidationRuns.archivedMessages} into the live session and cascades
 * deletion of the memories/archive the pass created. Only the most recent runs
 * per session are kept (see the prune policy in the memory service); pruned
 * passes lose undo but their memories and archived summary stay.
 */
export const consolidationRuns = pgTable('consolidation_runs', {
  id: text('id').primaryKey(),
  /**
   * Monotonic insertion order for LIFO undo. `created_at` alone can tie within
   * one timestamp tick when passes run back-to-back (e.g. in tests).
   */
  seq: serial('seq').notNull(),
  /** Character card this run belongs to. */
  characterId: text('character_id').notNull().default('default'),
  sessionId: text('session_id').notNull(),
  /** The live-session messages (with ids) the pass trimmed, verbatim for restore. */
  archivedMessages: jsonb('archived_messages').$type<unknown[]>().notNull().default([]),
  /** `memory_items` ids created by this pass; deleted together on undo. */
  memoryIds: jsonb('memory_ids').$type<string[]>().notNull().default([]),
  /** `archived_summaries` id created by this pass; deleted together on undo. */
  archiveId: text('archive_id').notNull(),
  roundFrom: integer('round_from'),
  roundTo: integer('round_to'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export type MemoryItemRow = typeof memoryItems.$inferSelect
export type NewMemoryItem = typeof memoryItems.$inferInsert
export type ArchivedSummaryRow = typeof archivedSummaries.$inferSelect
export type NewArchivedSummary = typeof archivedSummaries.$inferInsert
export type ConsolidationRunRow = typeof consolidationRuns.$inferSelect
export type NewConsolidationRun = typeof consolidationRuns.$inferInsert

export const memorySchema = { memoryItems, archivedSummaries, consolidationRuns }
