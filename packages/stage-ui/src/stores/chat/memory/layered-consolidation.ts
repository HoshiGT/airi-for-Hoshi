import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { MemoryRepository } from './repository'
import type { NewMemoryItem } from './schema'

import { generateText } from '@xsai/generate-text'
import { nanoid } from 'nanoid'
import { array, maxValue, minValue, number, object, parse, pipe, string } from 'valibot'

import { buildTranscript, extractJson } from './consolidation'

/**
 * Layered consolidation model calls (L1 → L2 → L3).
 *
 * Kept separate from the classic {@link runConsolidation} pass: layered passes
 * write memory items only (no `archived_summaries`, no undo backup) and run
 * incrementally at the warm-up cadence, while the classic pass archives whole
 * trimmed rounds and stays the manual / daily-consolidation path.
 *
 * Each pass reads existing memories of the same tier for dedup context and
 * stamps its source items with `aggregated_at` on success (the repository's
 * watermark that drives the next tier's batch).
 */

/** One structured fact the L1 pass extracted and classified. */
const l1OutputSchema = object({
  items: array(object({
    content: string(),
    kind: string(),
    importance: pipe(number(), minValue(0), maxValue(1)),
    keywords: array(string()),
  })),
})

/** One aggregated scene (L2) or profile (L3) item. */
const aggregateOutputSchema = object({
  items: array(object({
    content: string(),
    importance: pipe(number(), minValue(0), maxValue(1)),
    keywords: array(string()),
  })),
})

function formatExistingItems(items: Array<{ content: string, keywords: string[] }>): string {
  if (items.length === 0)
    return ''
  const lines = items.map(item => `- ${item.content} (keywords: ${item.keywords.join(', ')})`)
  return ['Already recorded (do NOT repeat these):', ...lines].join('\n')
}

/**
 * Shape the three tiers' system prompts share: JSON only, no duplicate facts.
 * `{alreadyRecorded}` is substituted with the dedup block at call time, when
 * the tier's existing items are known.
 */
function buildPrompt(instructions: string, jsonShape: string): string {
  return [
    instructions,
    '',
    'Respond with ONLY a JSON object, no prose, no markdown fences:',
    jsonShape,
    '',
    '{alreadyRecorded}',
  ].join('\n')
}

const L1_PROMPT = buildPrompt(
  [
    'You distill recent conversation rounds into structured memory facts for an AI companion.',
    'Given the newest rounds of a conversation, extract the individual facts worth remembering.',
    'For each fact decide:',
    '- kind: "long" for stable facts (identity, preferences, relationships, long-running goals);',
    '  "short" for transient context (current task, today\'s plan) that matters now but decays.',
    '- importance: 0..1, higher for facts that recur or that the user clearly cares about.',
    '- keywords: a few lowercased entities/topics for later keyword recall.',
    'If nothing new is worth remembering, return an empty items array.',
  ].join('\n'),
  '{"items": [{"content": string, "kind": "long"|"short", "importance": number, "keywords": string[]}]}',
)

const L2_PROMPT = buildPrompt(
  [
    'You aggregate structured memory facts into scene-level summaries for an AI companion.',
    'Given a batch of individual facts from one conversation, merge them into a few cohesive',
    '"scene" memories — each one a compressed narrative of a topic or episode the batch covers',
    '(e.g. "over several days the user debugged a QQ bot voice feature...").',
    'Merged facts must not be repeated as standalone items; drop anything trivial.',
    '- importance: 0..1, higher for scenes that recur or that the user clearly cares about.',
    '- keywords: a few lowercased entities/topics for later keyword recall.',
    'If the batch has nothing worth a scene, return an empty items array.',
  ].join('\n'),
  '{"items": [{"content": string, "importance": number, "keywords": string[]}]}',
)

const L3_PROMPT = buildPrompt(
  [
    'You distill a long-term profile of a user for an AI companion.',
    'Given a batch of scene-level memories from across conversations, extract stable,',
    'cross-conversation facts about the user: identity, preferences, relationships,',
    'skills, recurring concerns, and long-running goals.',
    'Write each fact as a standalone profile entry; do not reference the scenes themselves.',
    '- importance: 0..1, higher for facts that define the user or keep recurring.',
    '- keywords: a few lowercased entities/topics for later keyword recall.',
    'If nothing rises to profile level, return an empty items array.',
  ].join('\n'),
  '{"items": [{"content": string, "importance": number, "keywords": string[]}]}',
)

export interface LayerOneParams {
  provider: ChatProvider
  model: string
  characterId: string
  sessionId: string
  /** The new raw rounds being distilled (they stay in the live context). */
  messages: Message[]
  /** Inclusive 1-based round range the messages span, for provenance. */
  roundFrom: number
  roundTo: number
  repository: MemoryRepository
}

export interface AggregateParams {
  provider: ChatProvider
  model: string
  characterId: string
  sessionId: string
  repository: MemoryRepository
}

function toNewItems(
  items: Array<{ content: string, importance: number, keywords: string[] }>,
  context: { characterId: string, sessionId: string, layer: number, kind: string },
): NewMemoryItem[] {
  return items.map(item => ({
    id: nanoid(),
    characterId: context.characterId,
    sessionId: context.sessionId,
    kind: context.kind,
    layer: context.layer,
    content: item.content,
    importance: item.importance,
    keywords: item.keywords.map(keyword => keyword.toLowerCase()),
  }))
}

/**
 * L1 pass: distill the newest raw rounds into structured facts.
 *
 * Does NOT touch the live context — layered consolidation is non-destructive
 * by design; the classic daily pass is the only path that archives/trims.
 * Returns the number of facts written (0 when the model found nothing new).
 */
export async function runLayerOnePass(params: LayerOneParams): Promise<{ itemCount: number }> {
  const { provider, model, characterId, sessionId, messages, roundFrom, roundTo, repository } = params

  const existing = await repository.listMemoryItems({ characterId, sessionId, layer: 1 })
  const transcript = buildTranscript(messages)
  const completion = await generateText({
    ...provider.chat(model),
    messages: [
      { role: 'system', content: L1_PROMPT.replace('{alreadyRecorded}', formatExistingItems(existing)) },
      { role: 'user', content: transcript },
    ],
  })

  const output = parse(l1OutputSchema, extractJson(completion.text ?? ''))

  const items: NewMemoryItem[] = output.items.map(item => ({
    id: nanoid(),
    characterId,
    sessionId,
    kind: item.kind === 'short' ? 'short' : 'long',
    layer: 1,
    content: item.content,
    importance: item.importance,
    keywords: item.keywords.map(keyword => keyword.toLowerCase()),
    sourceRoundFrom: roundFrom,
    sourceRoundTo: roundTo,
  }))
  await repository.addMemoryItems(items)
  return { itemCount: items.length }
}

/**
 * L2 pass: aggregate the session's pending L1 facts into scene memories and
 * stamp the source facts as consumed.
 */
export async function runLayerTwoPass(params: AggregateParams): Promise<{ itemCount: number }> {
  const { provider, model, characterId, sessionId, repository } = params

  const pending = await repository.listPendingLayerItems(1, { characterId, sessionId })
  if (pending.length === 0)
    return { itemCount: 0 }

  const existing = await repository.listMemoryItems({ characterId, layer: 2 })
  const completion = await generateText({
    ...provider.chat(model),
    messages: [
      { role: 'system', content: L2_PROMPT.replace('{alreadyRecorded}', formatExistingItems(existing)) },
      { role: 'user', content: pending.map(item => `- ${item.content} (keywords: ${item.keywords.join(', ')})`).join('\n') },
    ],
  })

  const output = parse(aggregateOutputSchema, extractJson(completion.text ?? ''))

  await repository.addMemoryItems(toNewItems(output.items, {
    characterId,
    sessionId,
    layer: 2,
    kind: 'long',
  }))
  // Stamp regardless of output size: an empty result still means the batch was
  // reviewed, and leaving it un-stamped would re-submit it on every next turn.
  await repository.markItemsAggregated(pending.map(item => item.id))
  return { itemCount: output.items.length }
}

/**
 * L3 pass: aggregate the character's pending L2 scenes into global profile
 * facts. Profile items live under the `global` sentinel session so they
 * survive per-session clears while still scoping to the character.
 */
export async function runLayerThreePass(params: AggregateParams): Promise<{ itemCount: number }> {
  const { provider, model, characterId, repository } = params

  const pending = await repository.listPendingLayerItems(2, { characterId })
  if (pending.length === 0)
    return { itemCount: 0 }

  const existing = await repository.listMemoryItems({ characterId, layer: 3 })
  const completion = await generateText({
    ...provider.chat(model),
    messages: [
      { role: 'system', content: L3_PROMPT.replace('{alreadyRecorded}', formatExistingItems(existing)) },
      { role: 'user', content: pending.map(item => `- ${item.content} (keywords: ${item.keywords.join(', ')})`).join('\n') },
    ],
  })

  const output = parse(aggregateOutputSchema, extractJson(completion.text ?? ''))

  await repository.addMemoryItems(toNewItems(output.items, {
    characterId,
    // Global profile facts are character-scoped, not conversation-scoped.
    sessionId: 'global',
    layer: 3,
    kind: 'long',
  }))
  await repository.markItemsAggregated(pending.map(item => item.id))
  return { itemCount: output.items.length }
}
