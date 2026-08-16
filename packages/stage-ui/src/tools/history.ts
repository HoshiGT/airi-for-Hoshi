import type { ChatHistoryItem } from '@proj-airi/core-agent'
import type { Tool } from '@xsai/shared-chat'

import type { HistoryHit, HistoryRound, HistorySessionSource } from '../stores/chat/memory/history'
import type { ArchivedSummaryRow } from '../stores/chat/memory/schema'

import { formatTimePrefix } from '@proj-airi/core-agent'
import { rawTool } from '@xsai/tool'
import { toJsonSchema } from 'xsschema'
import { z } from 'zod/v4'

import { readArchivedRounds, readHistoryRounds, searchHistory } from '../stores/chat/memory/history'
import { normalizeNullableAnyOf } from './json-schema'

/** Hits returned when the model does not ask for a specific number. */
const DEFAULT_SEARCH_LIMIT = 8
const MIN_SEARCH_LIMIT = 1
const MAX_SEARCH_LIMIT = 20

/**
 * How many conversations one search may pull out of storage.
 *
 * Every scanned session means reading its whole message payload back from
 * IndexedDB, so an unbounded search would grow with the user's entire history.
 * Sessions are scanned newest-first, which is where "what did we say last time"
 * lives; older ones stay reachable through their archived summaries, which are
 * small enough to always search in full.
 */
const MAX_SEARCHED_SESSIONS = 40

/** Rounds one `history_read` call may return, keeping a reply context-sized. */
const MAX_READ_ROUNDS = 12

// Optional inputs are modelled as required-nullable for the same reason as in
// `memory.ts`: strict OpenAI-compatible providers reject tool schemas whose
// properties are missing from `required`. See the NOTICE in createHistoryTools.
const historySearchParameters = z.object({
  query: z.string().min(1).max(200).describe('Words to look for in what was actually said. Matching is literal, not semantic — use the names, nouns and phrasings you expect to appear in the conversation itself.'),
  limit: z.union([z.number().int().min(MIN_SEARCH_LIMIT).max(MAX_SEARCH_LIMIT), z.null()]).describe(`How many matches to return (${MIN_SEARCH_LIMIT}-${MAX_SEARCH_LIMIT}), or null for the default of ${DEFAULT_SEARCH_LIMIT}.`),
})

const historyReadParameters = z.object({
  session_id: z.union([z.string().min(1), z.null()]).describe('The conversation id from a search result. Null only when reading an archive instead.'),
  round_from: z.union([z.number().int().min(1), z.null()]).describe('First round to read, taken from a search result. Null starts at the beginning of the conversation.'),
  round_to: z.union([z.number().int().min(1), z.null()]).describe('Last round to read. Null reads a short span starting at round_from.'),
  archive_id: z.union([z.string().min(1), z.null()]).describe('The archive id from a search result, to read a compacted stretch of conversation in full instead of a live session. Null when reading by session_id.'),
})

type HistorySearchInput = z.infer<typeof historySearchParameters>
type HistoryReadInput = z.infer<typeof historyReadParameters>

/**
 * System-prompt guidance that MUST accompany these tools whenever they are
 * mounted.
 *
 * The distinction these tools need the model to hold — recall searches what you
 * concluded, history searches what was said — is not inferable from the tool
 * descriptions alone, and without it the model treats a failed `memory_recall`
 * as proof the conversation never happened.
 */
export const HISTORY_TOOLSET_PROMPT = `You can also search the raw text of your past conversations, across every conversation you have had with this user — not just this one:
- \`history_search\`: find what was actually said. Use it when the user refers to an earlier conversation ("last time", "what did we decide about X"), when \`memory_recall\` comes back empty but the topic sounds like something you discussed, or when you need someone's exact words rather than your summary of them.
- \`history_read\`: after a search, read the surrounding rounds in full so you answer from the real exchange instead of a fragment.

\`memory_recall\` searches what you distilled and kept; these search the transcript itself, so they can find things you never turned into a memory. Search on your own initiative and don't announce it. If something you find is worth keeping, save it with \`memory_save\` — that decision is yours to make, not something that happens automatically.`

/**
 * Extra guidance mounted ONLY while consolidation is set to trim the live
 * conversation (`trimAfterConsolidation`).
 *
 * Without it the model has no way to tell a compacted conversation from a short
 * one: the visible history simply starts partway in, looks complete, and the
 * natural reading of a reference it cannot place is that the user is
 * misremembering. It then answers from what it can see — which is the failure
 * this whole search capability exists to prevent.
 *
 * Gated rather than always-on because with trimming off it would be false: the
 * rounds really are all still there, and telling the model otherwise would send
 * it searching for context it already has in front of it.
 */
export const COMPACTED_CONTEXT_PROMPT = `The older rounds of this conversation are no longer in your context. What you can see starts partway in — earlier turns were summarized into memories and archived, not kept verbatim.

So when the user refers to something you cannot find above, the default explanation is that it was compacted, not that they are misremembering. Use \`history_search\` to pull the real exchange back before you answer, and never reconstruct what was "probably" said from the part you can still see.`

/**
 * Read access to conversation storage, injected rather than imported.
 *
 * These tools need chat sessions *and* the memory archive; importing either
 * store here would close the same import cycle `MemoryToolsService` in
 * `tools/memory.ts` avoids, and injection lets tests drive the tools from plain
 * arrays instead of IndexedDB and PGlite.
 */
export interface HistoryToolsService {
  /**
   * Every conversation belonging to a character, without message payloads.
   * Order does not matter; the tool sorts by `updatedAt` before applying its
   * own scan cap.
   */
  listSessions: (characterId: string) => Promise<{ sessionId: string, title?: string, updatedAt?: number }[]>
  /** Full message list of one conversation, loading it from storage if needed. */
  readSession: (sessionId: string) => Promise<ChatHistoryItem[]>
  /** Consolidation archives for a character, newest first. */
  listArchives: (characterId: string) => Promise<ArchivedSummaryRow[]>
}

export interface HistoryToolsOptions {
  service: HistoryToolsService
  /**
   * The character whose conversations are searchable. Resolved per call, not at
   * mount time, so switching cards mid-session never exposes one character's
   * conversations to another.
   */
  getCharacterId: () => string
}

function formatAt(at?: number): string {
  return at ? formatTimePrefix(at).trim().replace(/^\[|\]$/g, '') : 'time unknown'
}

/**
 * Renders hits as a list the model can both read and act on: every line carries
 * the ids and round numbers `history_read` needs, so a follow-up read never
 * requires guessing.
 *
 * Left outside an `<untrusted_content>` envelope for the same reason as recalled
 * memories: this is the user's own conversation with this character, already the
 * kind of content the live context is made of.
 */
function formatHits(query: string, hits: HistoryHit[]): string {
  if (hits.length === 0)
    return `Nothing in your past conversations matched "${query}". Matching is literal — a different wording may still find it.`

  const lines = hits.map((hit) => {
    const where = hit.source === 'archive-summary'
      ? `archive ${hit.archiveId} (summary of session ${hit.sessionId})`
      : `session ${hit.sessionId}${hit.sessionTitle ? ` "${hit.sessionTitle}"` : ''}`
    const round = hit.round == null ? '' : `, round ${hit.round}`
    return `- [${where}${round}, ${formatAt(hit.at)}] ${hit.role}: ${hit.snippet}`
  })

  return `${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}" in past conversations:\n${lines.join('\n')}\nRead any of these in full with history_read.`
}

function formatRounds(header: string, rounds: HistoryRound[]): string {
  if (rounds.length === 0)
    return `${header}\n(No rounds in that range — the round numbers may be stale; search again.)`

  const body = rounds.map((round) => {
    const turns = round.messages.map(message => `${message.role}: ${message.text}`).join('\n')
    return `--- round ${round.round} ---\n${turns}`
  })
  return `${header}\n${body.join('\n')}`
}

/**
 * Builds the `history_search` / `history_read` tools, which let the character
 * look up what was actually said in any of its past conversations.
 *
 * These complement the memory tools rather than replacing them: `memory_recall`
 * reaches distilled facts, these reach the transcript — including sessions other
 * than the open one, which is the case recall structurally cannot serve. Mount
 * them alongside {@link HISTORY_TOOLSET_PROMPT}, which carries that distinction.
 *
 * Search is read-only. Turning something found here into a durable memory is a
 * separate, deliberate `memory_save` call.
 */
export async function createHistoryTools(options: HistoryToolsOptions): Promise<Tool[]> {
  const { service, getCharacterId } = options

  // NOTICE: built via rawTool (not tool()) so normalizeNullableAnyOf can collapse
  // scalar `x | null` unions to `type: ['x', 'null']` before strictJsonSchema
  // finalizes the schema — the anyOf-with-null shape tool() emits is rejected by
  // strict OpenAI-compatible providers (e.g. Azure). Mirrors createMemoryTools.
  // The collapse drops numeric bounds, so `limit` and the round range are
  // clamped at runtime below.
  const [searchParameters, readParameters] = await Promise.all([
    toJsonSchema(historySearchParameters).then(normalizeNullableAnyOf),
    toJsonSchema(historyReadParameters).then(normalizeNullableAnyOf),
  ])

  async function loadSessions(characterId: string): Promise<HistorySessionSource[]> {
    const metas = await service.listSessions(characterId)
    const newestFirst = [...metas].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return Promise.all(
      newestFirst.slice(0, MAX_SEARCHED_SESSIONS).map(async meta => ({
        sessionId: meta.sessionId,
        title: meta.title,
        updatedAt: meta.updatedAt,
        messages: await service.readSession(meta.sessionId),
      })),
    )
  }

  return [
    rawTool({
      // NOTICE: snake_case with no `builtIn_` prefix, matching `memory_*` and
      // `web_search` — user-facing capabilities gated by settings, unlike the
      // always-on `builtIn_` infra tools.
      name: 'history_search',
      description: 'Search the raw text of your past conversations with this user, across every conversation and not only the current one. Use it when they refer to something said earlier, or when memory recall finds nothing but the topic sounds familiar.',
      parameters: searchParameters,
      execute: async (rawInput) => {
        const input = rawInput as HistorySearchInput
        const query = input.query.trim()
        if (!query)
          return 'Nothing was searched: the query was empty.'

        // Same reason as `limit` in memory_recall: the 1..20 bound does not
        // survive the anyOf→type[] collapse, so clamp before searching.
        const limit = Math.min(Math.max(MIN_SEARCH_LIMIT, Math.trunc(input.limit ?? DEFAULT_SEARCH_LIMIT)), MAX_SEARCH_LIMIT)
        const characterId = getCharacterId()
        const [sessions, archives] = await Promise.all([
          loadSessions(characterId),
          service.listArchives(characterId),
        ])

        return formatHits(query, searchHistory({ sessions, archives }, query, limit))
      },
    }),
    rawTool({
      name: 'history_read',
      description: 'Read a stretch of a past conversation in full, using the session id (or archive id) and round numbers from a history_search result.',
      parameters: readParameters,
      execute: async (rawInput) => {
        const input = rawInput as HistoryReadInput

        if (input.archive_id) {
          const characterId = getCharacterId()
          const archive = (await service.listArchives(characterId)).find(row => row.id === input.archive_id)
          if (!archive)
            return `No archived conversation with id "${input.archive_id}" exists for this character.`

          const header = `Archived summary of session ${archive.sessionId}, rounds ${archive.roundFrom ?? '?'}-${archive.roundTo ?? '?'} (${formatAt(archive.createdAt.getTime())}):\n${archive.summary}\n\nThe original messages:`
          return formatRounds(header, readArchivedRounds(archive).slice(0, MAX_READ_ROUNDS))
        }

        if (!input.session_id)
          return 'Nothing was read: pass either a session_id or an archive_id from a history_search result.'

        const messages = await service.readSession(input.session_id)
        if (messages.length === 0)
          return `No conversation with id "${input.session_id}" was found; run history_search again to get a current id.`

        // The bounds are gone after the anyOf collapse and the model may echo a
        // stale round number, so normalize here rather than trusting the input:
        // a null start means "the tail", and the span is capped so one read
        // cannot flood the context.
        const from = Math.max(1, Math.trunc(input.round_from ?? 1))
        const requestedTo = input.round_to == null ? from + 2 : Math.trunc(input.round_to)
        const to = Math.max(from, Math.min(requestedTo, from + MAX_READ_ROUNDS - 1))

        const rounds = readHistoryRounds(messages, from, to)
        return formatRounds(`Session ${input.session_id}, rounds ${from}-${to}:`, rounds)
      },
    }),
  ]
}
