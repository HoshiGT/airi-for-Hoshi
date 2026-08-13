import type { Tool } from '@xsai/shared-chat'

import type { MemoryKind, RankedMemory, RetrieveOptions } from '../stores/chat/memory/repository'

import { rawTool } from '@xsai/tool'
import { toJsonSchema } from 'xsschema'
import { z } from 'zod/v4'

import { normalizeNullableAnyOf } from './json-schema'

/** Recall size when the model does not ask for a specific number. */
const DEFAULT_RECALL_LIMIT = 6
/** Inclusive bounds for the recall size, enforced at runtime (see below). */
const MIN_RECALL_LIMIT = 1
const MAX_RECALL_LIMIT = 20
/** Neutral weight for a memory the model saved without judging importance. */
const DEFAULT_IMPORTANCE = 0.5

// Optional inputs are modelled as required-nullable (never `.optional()`): strict
// OpenAI-compatible providers reject tool schemas whose properties are missing
// from `required`, so mounting the tools could otherwise 400 the whole request.
// The generated schemas are further run through normalizeNullableAnyOf (see the
// factory below) so scalar `x | null` unions ship as `type: ['x', 'null']`.
const memorySaveParameters = z.object({
  content: z.string().min(2).max(1000).describe('The thing to remember, written so it still makes sense months from now with no surrounding conversation. Name who or what it is about instead of relying on pronouns.'),
  kind: z.union([z.enum(['long', 'short']), z.null()]).describe(`'long' for facts that stay true past this conversation (preferences, relationships, ongoing plans), 'short' for context that only matters right now, or null for 'long'.`),
  importance: z.union([z.number().min(0).max(1), z.null()]).describe('How much this matters, from 0 to 1. Around 0.8 for identity and strong preferences you must not forget, around 0.5 for ordinary facts, or null for 0.5.'),
  keywords: z.union([z.array(z.string().min(1).max(32)).max(12), z.null()]).describe('The words you would search for to find this again (names, topics). Null lets recall match against the content itself.'),
})

const memoryRecallParameters = z.object({
  query: z.string().min(1).max(400).describe('Words describing what you are trying to remember. Matching is by keyword overlap, not meaning, so use the concrete nouns and names you expect the memory to contain.'),
  limit: z.union([z.number().int().min(MIN_RECALL_LIMIT).max(MAX_RECALL_LIMIT), z.null()]).describe(`How many memories to return (${MIN_RECALL_LIMIT}-${MAX_RECALL_LIMIT}), or null for the default of ${DEFAULT_RECALL_LIMIT}.`),
})

const memoryForgetParameters = z.object({
  query: z.string().min(1).max(400).describe('Words identifying the single memory to delete. Only the best-matching memory is deleted, so be specific — quote the wording you saw when you recalled it.'),
})

type MemorySaveInput = z.infer<typeof memorySaveParameters>
type MemoryRecallInput = z.infer<typeof memoryRecallParameters>
type MemoryForgetInput = z.infer<typeof memoryForgetParameters>

/**
 * System-prompt guidance that MUST accompany these tools whenever they are
 * mounted.
 *
 * The tools themselves carry no policy about *when* to remember — left to the
 * model's defaults it either never saves anything or narrates every save. This
 * text is where "save without asking, prefer few good memories, don't announce
 * a recall" lives, so ship it together with the tools.
 */
export const MEMORY_TOOLSET_PROMPT = `You have a persistent memory that survives across conversations. Use it on your own initiative:
- \`memory_save\`: store facts worth keeping — who the user is, what they prefer, decisions and plans, things that happened that you would want to bring up later. Use 'long' for what stays true beyond this conversation and 'short' for context that only matters now. Skip anything trivial, obvious, or easy to re-derive.
- \`memory_recall\`: search your memories when the conversation touches something you may already know. Do it naturally and don't announce the lookup; just use what comes back.
- \`memory_forget\`: delete a memory that turned out wrong or is now outdated. It removes the single best keyword match, so recall first and pass wording specific enough to hit that one memory.

Save and recall without asking permission — this is your own memory, not a feature you operate for the user. Prefer a few well-written memories over many shallow ones, and tell the user plainly if they ask what you remember.`

/**
 * The slice of the memory service (`useMemoryService`) these tools drive.
 *
 * Injected rather than imported: the memory module store imports
 * {@link MEMORY_TOOLSET_PROMPT} from this file, and the memory service imports
 * that same module store — reaching for `useMemoryService()` here would close
 * that loop into an import cycle. Injection also lets the tests exercise the
 * tools against a fake repository instead of standing up PGlite.
 */
export interface MemoryToolsService {
  addMemory: (input: {
    characterId: string
    content: string
    kind?: MemoryKind
    importance?: number
    keywords?: string[]
    sessionId?: string
  }) => Promise<void>
  recall: (query: string, options?: RetrieveOptions) => Promise<RankedMemory[]>
  removeMemory: (id: string) => Promise<void>
}

export interface MemoryToolsOptions {
  service: MemoryToolsService
  /**
   * The character whose memories this turn reads and writes. Resolved per call,
   * not captured at mount time, so switching cards mid-session does not leak
   * memories across characters or require re-registering the tools.
   */
  getCharacterId: () => string
  /**
   * The session a saved memory is attributed to. Read per call for the same
   * reason as {@link getCharacterId}.
   */
  getSessionId: () => string
}

/**
 * Renders recalled memories as a compact list the model can read and quote.
 *
 * Deliberately *not* wrapped in an `<untrusted_content>` envelope the way web
 * search results are: memories are distilled from this user's own conversations,
 * so they carry no new trust boundary — treating them as untrusted data would
 * only teach the model to discount its own memory.
 */
function formatRecall(query: string, memories: RankedMemory[]): string {
  if (memories.length === 0)
    return `No stored memories matched "${query}".`

  const lines = memories.map(({ item }) => {
    const tags = item.keywords.length > 0 ? ` (tags: ${item.keywords.join(', ')})` : ''
    return `- [${item.kind}-term, importance ${item.importance.toFixed(2)}] ${item.content}${tags}`
  })

  return `${memories.length} stored memor${memories.length === 1 ? 'y' : 'ies'} matched "${query}":\n${lines.join('\n')}`
}

/**
 * Builds the `memory_save` / `memory_recall` / `memory_forget` tools that let the
 * character curate its own persistent memory during a conversation.
 *
 * Mount these only when the memory module is configured and the user has left
 * in-chat memory management enabled — see `resolveMemoryTools` in
 * `stores/llm-tool-resolver.ts` — and always alongside
 * {@link MEMORY_TOOLSET_PROMPT}, which carries the when-to-use policy.
 *
 * Writes land in the same store the consolidation pipeline fills, so a
 * model-saved memory is indistinguishable from a distilled one in the settings
 * UI and can be edited or deleted there.
 */
export async function createMemoryTools(options: MemoryToolsOptions): Promise<Tool[]> {
  const { service, getCharacterId, getSessionId } = options

  // NOTICE: built via rawTool (not tool()) so the generated JSON Schema can be
  // normalized before strictJsonSchema finalizes it. normalizeNullableAnyOf
  // collapses scalar `x | null` unions to `type: ['x', 'null']`, the form strict
  // OpenAI-compatible providers (e.g. Azure) accept — the anyOf-with-null shape
  // tool() would emit is rejected. Mirrors createWebSearchTools. The collapse
  // drops the scalar bounds on `importance`/`limit`, so both are clamped at
  // runtime below.
  const [saveParameters, recallParameters, forgetParameters] = await Promise.all([
    toJsonSchema(memorySaveParameters).then(normalizeNullableAnyOf),
    toJsonSchema(memoryRecallParameters).then(normalizeNullableAnyOf),
    toJsonSchema(memoryForgetParameters).then(normalizeNullableAnyOf),
  ])

  return [
    rawTool({
      // NOTICE: intentionally snake_case with no `builtIn_` prefix, matching
      // `web_search` — these are user-facing capabilities gated by settings,
      // unlike the always-on `builtIn_` infra tools (mcp/debug/spark).
      name: 'memory_save',
      description: 'Save something to your persistent memory so you still know it in future conversations. Use it for facts about the user, their preferences, decisions, and events worth remembering — not for trivia or anything restated in the conversation itself.',
      parameters: saveParameters,
      execute: async (rawInput) => {
        const input = rawInput as MemorySaveInput
        const content = input.content.trim()
        if (!content)
          return 'Nothing was saved: the memory content was empty.'

        // normalizeNullableAnyOf drops the schema's 0..1 bound, so re-enforce it
        // here — the keyword retriever multiplies by importance when ranking, and
        // an out-of-range weight would silently dominate every recall.
        const importance = Math.min(Math.max(0, input.importance ?? DEFAULT_IMPORTANCE), 1)
        // The collapse also drops `kind`'s enum (it ships as `string | null`), so
        // the model can hand over any word. `kind` is a bare text column, so an
        // unrecognized value would persist and then never match either filter;
        // anything that is not explicitly 'short' becomes a long-term memory.
        const kind: MemoryKind = input.kind === 'short' ? 'short' : 'long'

        await service.addMemory({
          characterId: getCharacterId(),
          sessionId: getSessionId(),
          content,
          kind,
          importance,
          keywords: input.keywords ?? [],
        })

        return `Saved to memory as a ${kind}-term memory: "${content}"`
      },
    }),
    rawTool({
      name: 'memory_recall',
      description: 'Search your persistent memory for what you already know about a topic. Matching is by keyword overlap, so query with the concrete names and nouns you expect the memory to contain.',
      parameters: recallParameters,
      execute: async (rawInput) => {
        const input = rawInput as MemoryRecallInput
        // Same reason as `importance` above: the 1..20 bound does not survive the
        // anyOf→type[] collapse, so clamp before it reaches the repository.
        const limit = Math.min(Math.max(MIN_RECALL_LIMIT, Math.trunc(input.limit ?? DEFAULT_RECALL_LIMIT)), MAX_RECALL_LIMIT)
        // Scoped by character only, never by session: the point of recall is
        // reaching conversations other than this one.
        const memories = await service.recall(input.query, { characterId: getCharacterId(), limit })
        return formatRecall(input.query, memories)
      },
    }),
    rawTool({
      name: 'memory_forget',
      description: 'Delete the memory that best matches a query, for when something you stored turned out wrong or is now outdated. Only one memory is removed per call.',
      parameters: forgetParameters,
      execute: async (rawInput) => {
        const input = rawInput as MemoryForgetInput
        // Deleting the top hit of a fresh single-result recall keeps the tool
        // honest: the model never guesses an id, and the deleted text is echoed
        // back so it can tell the user exactly what went. The recall's
        // access-count bump on this row is moot — the row is about to be gone.
        const [match] = await service.recall(input.query, { characterId: getCharacterId(), limit: 1 })
        if (!match)
          return `No stored memory matched "${input.query}"; nothing was deleted.`

        await service.removeMemory(match.item.id)
        return `Deleted this memory: "${match.item.content}"`
      },
    }),
  ]
}
