import type { PgliteDatabase } from 'drizzle-orm/pglite'

import { PGlite } from '@electric-sql/pglite'
import { Mutex } from 'async-mutex'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { shallowRef } from 'vue'

import { memorySchema } from './schema'

export type MemoryDatabase = PgliteDatabase<typeof memorySchema>

// NOTICE:
// `idb://` makes PGlite persist to IndexedDB so memories survive reloads. The
// name is namespaced to avoid colliding with any future PGlite-backed store.
const PGLITE_DATA_DIR = 'idb://airi-memory'

const db = shallowRef<MemoryDatabase | null>(null)
const client = shallowRef<PGlite | null>(null)
// Serialize init/close so concurrent callers can't open two PGlite instances
// against the same IndexedDB directory.
const mutex = new Mutex()

/**
 * Apply the memory tables with idempotent DDL instead of drizzle-kit migrations.
 *
 * Running drizzle-kit's pushSchema in the browser would pull the migration
 * toolchain into the app bundle; the schema here is small and append-only, so
 * `CREATE TABLE IF NOT EXISTS` (mirroring {@link useDuckDb}) is enough. When
 * Phase 3 adds the `vector` embedding column this is where the `ALTER TABLE`
 * guard lands.
 *
 * Exported so tests can stand up the same tables against an in-memory PGlite
 * without going through the IndexedDB-backed singleton.
 */
export async function applyMemorySchema(database: MemoryDatabase): Promise<void> {
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL DEFAULT 'default',
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      layer INTEGER NOT NULL DEFAULT 1,
      content TEXT NOT NULL,
      importance REAL NOT NULL,
      keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
      source_round_from INTEGER,
      source_round_to INTEGER,
      aggregated_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      last_accessed_at TIMESTAMP,
      access_count INTEGER NOT NULL DEFAULT 0
    );
  `)
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS archived_summaries (
      id TEXT PRIMARY KEY,
      character_id TEXT NOT NULL DEFAULT 'default',
      session_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      raw_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      round_from INTEGER,
      round_to INTEGER,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `)
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS consolidation_runs (
      id TEXT PRIMARY KEY,
      seq SERIAL NOT NULL,
      character_id TEXT NOT NULL DEFAULT 'default',
      session_id TEXT NOT NULL,
      archived_messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      archive_id TEXT NOT NULL,
      round_from INTEGER,
      round_to INTEGER,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `)
  // Migration: add character_id to existing tables (no-op on fresh installs
  // because CREATE TABLE already includes the column).
  await database.execute(sql`ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS character_id TEXT NOT NULL DEFAULT 'default';`)
  await database.execute(sql`ALTER TABLE archived_summaries ADD COLUMN IF NOT EXISTS character_id TEXT NOT NULL DEFAULT 'default';`)
  await database.execute(sql`ALTER TABLE consolidation_runs ADD COLUMN IF NOT EXISTS character_id TEXT NOT NULL DEFAULT 'default';`)

  // Migration: layered-consolidation columns. Legacy rows land on layer 1 with
  // a null aggregation watermark, i.e. they join the next L2 batch like fresh
  // L1 facts (no-op on fresh installs, same as character_id above).
  await database.execute(sql`ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS layer INTEGER NOT NULL DEFAULT 1;`)
  await database.execute(sql`ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS aggregated_at TIMESTAMP;`)

  // Layered-consolidation progress state, one row per (character, session).
  await database.execute(sql`
    CREATE TABLE IF NOT EXISTS memory_layer_state (
      character_id TEXT NOT NULL DEFAULT 'default',
      session_id TEXT NOT NULL,
      warmup_step INTEGER NOT NULL DEFAULT 1,
      l1_rounds_processed INTEGER NOT NULL DEFAULT 0,
      l1_pass_count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (character_id, session_id)
    );
  `)

  await database.execute(sql`CREATE INDEX IF NOT EXISTS memory_items_session_idx ON memory_items (session_id);`)
  await database.execute(sql`CREATE INDEX IF NOT EXISTS memory_items_kind_idx ON memory_items (kind);`)
  await database.execute(sql`CREATE INDEX IF NOT EXISTS memory_items_character_idx ON memory_items (character_id);`)
  await database.execute(sql`CREATE INDEX IF NOT EXISTS consolidation_runs_session_idx ON consolidation_runs (session_id);`)
}

/**
 * Shared accessor for the browser memory database.
 *
 * Lazily opens a single persistent PGlite instance and bootstraps its tables.
 * The instance is module-scoped so every store/composable observes the same
 * connection; call {@link closeDb} on teardown to release the worker.
 */
export function useMemoryDb() {
  const getDb = () => mutex.runExclusive(async () => {
    if (db.value)
      return db.value

    let pglite: PGlite | undefined
    try {
      pglite = new PGlite(PGLITE_DATA_DIR)
      const database = drizzle(pglite, { schema: memorySchema })
      await applyMemorySchema(database)
      client.value = pglite
      db.value = database
      return database
    }
    catch (error) {
      // Drop the half-open instance so a later retry starts clean.
      await pglite?.close().catch(() => {})
      throw error
    }
  })

  const closeDb = () => mutex.runExclusive(async () => {
    if (!client.value)
      return
    try {
      await client.value.close()
    }
    catch (error) {
      console.error(`Error closing memory PGlite: ${error}. The instance reference is dropped regardless.`)
    }
    client.value = null
    db.value = null
  })

  return { db, getDb, closeDb }
}
