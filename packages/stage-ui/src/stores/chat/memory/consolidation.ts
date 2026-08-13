import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'
import type { InferOutput } from 'valibot'

import type { MemoryRepository } from './repository'

import { generateText } from '@xsai/generate-text'
import { nanoid } from 'nanoid'
import { array, maxValue, minValue, number, object, parse, picklist, pipe, string } from 'valibot'

/** One distilled fact the model extracted and classified. */
const distilledMemorySchema = object({
  content: string(),
  kind: picklist(['long', 'short']),
  importance: pipe(number(), minValue(0), maxValue(1)),
  keywords: array(string()),
})

/** The full structured output expected from a consolidation pass. */
const consolidationOutputSchema = object({
  summary: string(),
  items: array(distilledMemorySchema),
})

export type ConsolidationOutput = InferOutput<typeof consolidationOutputSchema>

/**
 * A persisted consolidation pass: the model output plus the ids of the rows it
 * wrote, so the caller can record an undo backup that cascades cleanly.
 */
export interface ConsolidationRecord extends ConsolidationOutput {
  /** Id of the `archived_summaries` row this pass created. */
  archiveId: string
  /** Ids of the `memory_items` rows this pass created. */
  memoryIds: string[]
}

const SYSTEM_PROMPT = [
  'You compress conversation history into durable memory for an AI companion.',
  'You are given the oldest rounds of a conversation that are about to be trimmed from the live context.',
  'Produce a compact narrative summary, then extract the individual facts worth remembering.',
  '',
  'For each extracted fact decide:',
  '- kind: "long" for stable facts (identity, preferences, relationships, long-running goals);',
  '  "short" for transient context (current task, today\'s plan) that matters now but decays.',
  '- importance: 0..1, higher for facts that recur or that the user clearly cares about.',
  '- keywords: a few lowercased entities/topics for later keyword recall.',
  '',
  'IMPORTANT: Do NOT extract facts that are already recorded in the existing memories',
  'listed below (if any). Only extract NEW information not yet covered.',
  'If an existing memory needs updating (e.g. a preference changed), extract the',
  'updated version with the same keywords so the caller can reconcile.',
  '',
  'Respond with ONLY a JSON object, no prose, no markdown fences:',
  '{"summary": string, "items": [{"content": string, "kind": "long"|"short", "importance": number, "keywords": string[]}]}',
].join('\n')

/**
 * Flattens an xsAI message's content to plain text for the transcript.
 *
 * Content can be a string or an array of parts; only text parts carry meaning
 * for summarization, so non-text parts (images, etc.) are dropped.
 */
function messageText(message: Message): string {
  const content = message.content
  if (typeof content === 'string')
    return content
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'object' && part != null && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('')
  }
  return ''
}

function buildTranscript(messages: Message[]): string {
  return messages
    .map(m => `${m.role}: ${messageText(m)}`)
    .filter(line => line.trim().length > 0)
    .join('\n')
}

/**
 * Extracts the JSON object from a model reply.
 *
 * Models (especially proxied ones) sometimes wrap JSON in ```json fences or add
 * a stray sentence despite instructions, so we slice from the first `{` to the
 * last `}` rather than trusting the whole string to be valid JSON.
 */
function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start)
    throw new Error('Consolidation model returned no JSON object')
  return JSON.parse(text.slice(start, end + 1))
}

export interface ConsolidationParams {
  provider: ChatProvider
  model: string
  characterId: string
  sessionId: string
  /** The oldest rounds being trimmed; summarized + archived, then removed upstream. */
  messages: Message[]
  /** Inclusive 1-based round range these messages span, for drill-back. */
  roundFrom?: number
  roundTo?: number
  /**
   * User-written guidance for what to remember and how (e.g. "focus on my
   * cat's habits, ignore small talk"). Appended to the system prompt.
   */
  guidance?: string
  repository: MemoryRepository
}

/**
 * Formats existing memories as a reference block so the model can skip
 * duplicates. Returns an empty string when there are no existing memories.
 */
function formatExistingMemories(memories: Array<{ content: string, kind: string, keywords: string[] }>): string {
  if (memories.length === 0)
    return ''

  const lines = memories.map(m =>
    `- [${m.kind}] ${m.content} (keywords: ${m.keywords.join(', ')})`,
  )
  return [
    '',
    'Existing memories already recorded (do NOT duplicate these):',
    ...lines,
  ].join('\n')
}

/**
 * Builds the consolidation system prompt with existing-memory dedup context
 * and optional user guidance. Guidance goes AFTER the core instructions so
 * the required output format stays authoritative even if the guidance rambles.
 */
function buildSystemPrompt(existingMemories: Array<{ content: string, kind: string, keywords: string[] }>, guidance?: string): string {
  const parts = [SYSTEM_PROMPT, formatExistingMemories(existingMemories)]

  const trimmed = guidance?.trim()
  if (trimmed) {
    parts.push(
      '',
      'The user also gave these preferences for what to remember and how to weigh it.',
      'Follow them when extracting, classifying, and scoring facts — but keep the JSON output format above:',
      trimmed,
    )
  }

  return parts.join('\n')
}

/**
 * Summarize+classify the trimmed rounds and persist them.
 *
 * Writes one `archived_summaries` row (summary + raw rounds for drill-back) and
 * the extracted, classified `memory_items`; the returned record carries their
 * ids so the caller can register an undo backup. Does NOT mutate the live chat
 * context — trimming the messages from the active conversation is the caller's
 * responsibility, kept separate so a failed model call never loses live history.
 */
export async function runConsolidation(params: ConsolidationParams): Promise<ConsolidationRecord> {
  const { provider, model, characterId, sessionId, messages, roundFrom, roundTo, guidance, repository } = params

  const existingMemories = await repository.listMemoryItems({ characterId })

  const transcript = buildTranscript(messages)
  const completion = await generateText({
    ...provider.chat(model),
    messages: [
      { role: 'system', content: buildSystemPrompt(existingMemories, guidance) },
      { role: 'user', content: transcript },
    ],
  })

  const output = parse(consolidationOutputSchema, extractJson(completion.text ?? ''))

  const archiveId = nanoid()
  await repository.addArchivedSummary({
    id: archiveId,
    characterId,
    sessionId,
    summary: output.summary,
    rawMessages: messages as unknown[],
    roundFrom,
    roundTo,
  })

  const items = output.items.map(item => ({
    id: nanoid(),
    characterId,
    sessionId,
    kind: item.kind,
    content: item.content,
    importance: item.importance,
    keywords: item.keywords.map(k => k.toLowerCase()),
    sourceRoundFrom: roundFrom,
    sourceRoundTo: roundTo,
  }))
  await repository.addMemoryItems(items)

  return { ...output, archiveId, memoryIds: items.map(item => item.id) }
}
