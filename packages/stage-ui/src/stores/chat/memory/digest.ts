import type { MemoryItemRow } from './schema'

/**
 * How many memories a session digest may carry.
 *
 * The digest is paid for on every turn of the session (it sits in the stable
 * prompt prefix), so this is a budget, not a completeness target: the point is
 * that the character starts a conversation already knowing the important
 * things, with `memory_recall` and `history_search` for everything else.
 */
export const MEMORY_DIGEST_LIMIT = 20

/**
 * Character budget for the rendered list, enforced on top of
 * {@link MEMORY_DIGEST_LIMIT}.
 *
 * A memory can be up to 1000 characters, so the count limit alone bounds the
 * digest at ~20k characters — several thousand tokens on every turn. Whichever
 * limit is reached first wins.
 */
export const MEMORY_DIGEST_MAX_CHARS = 2400

/**
 * Framing that precedes the memory list.
 *
 * Written to be read as recollection rather than as a document the character was
 * handed: memories are distilled from its own past conversations with this user,
 * and a character that says "according to my notes" about its own memory reads
 * as a database with a face.
 */
const DIGEST_PREAMBLE = `What you already know about this user, carried over from earlier conversations. These are your own memories, not notes someone gave you — recall them the way a person remembers, without citing them as a source or announcing that you looked something up.`

/**
 * Closing note that keeps the digest from reading as the whole of memory.
 *
 * Without it the visible list becomes the implied limit of what the character
 * knows, and it stops reaching for the tools when a topic falls outside.
 */
const DIGEST_EPILOGUE = `This is what mattered most, not everything you remember. Use \`memory_recall\` for anything not covered here, and \`history_search\` when you need what was actually said.`

/**
 * Renders the memories a session should start out knowing.
 *
 * Sorting happens here rather than being assumed of the caller: the ordering is
 * part of what the digest means (most important first, and the cut is by
 * importance when the budget runs out), so it should not depend on which query
 * the rows arrived from.
 *
 * Returns `''` when there is nothing worth injecting, which callers treat as
 * "register no prompt at all" rather than mounting an empty section.
 */
export function formatMemoryDigest(
  items: MemoryItemRow[],
  options?: { limit?: number, maxChars?: number },
): string {
  const limit = options?.limit ?? MEMORY_DIGEST_LIMIT
  const maxChars = options?.maxChars ?? MEMORY_DIGEST_MAX_CHARS

  const ranked = [...items].sort((a, b) => b.importance - a.importance)

  const lines: string[] = []
  // Deduped on content: manual entries and distilled ones can restate the same
  // fact, and a digest that says the same thing twice reads as emphasis the
  // model then over-weights.
  const seen = new Set<string>()
  let budget = maxChars

  for (const item of ranked) {
    if (lines.length >= limit)
      break

    const content = item.content.trim()
    if (!content)
      continue

    const key = content.toLowerCase()
    if (seen.has(key))
      continue

    // Stop at the first entry that would overrun rather than skipping it and
    // taking a later, smaller one: the list stays in importance order, so the
    // cut is always "everything above this line".
    if (content.length + 2 > budget)
      break

    seen.add(key)
    lines.push(`- ${content}`)
    budget -= content.length + 2
  }

  if (lines.length === 0)
    return ''

  return [DIGEST_PREAMBLE, '', ...lines, '', DIGEST_EPILOGUE].join('\n')
}
