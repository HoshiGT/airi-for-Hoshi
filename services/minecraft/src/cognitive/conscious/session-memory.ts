import type { Message } from '@xsai/shared-chat'

import path from 'node:path'
import process from 'node:process'

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import { z } from 'zod'

import { useLogger } from '../../utils/logger'
import { LLMAgent } from './llm-agent'

const logger = useLogger()

/**
 * Cross-session memory: carry a handful of durable facts across process restarts.
 *
 * WHY THIS EXISTS
 *
 * `Brain` trims `conversationHistory` in batches once it passes 200 messages, and the messages it
 * drops are the oldest — which is exactly where durable context accumulates: where the base is,
 * what the master asked for, what the bot was in the middle of doing, how the master likes to be
 * addressed. On restart even the untrimmed remainder is gone, since history lives only in memory.
 *
 * So the tail of the conversation is written to disk, and on the next startup a small, cheap model
 * condenses it into a short paragraph that is appended to the system prompt — where it is immune to
 * trimming and, being part of a stable prefix, read from the prompt cache on every turn.
 *
 * THE TWO CONSTRAINTS THAT SHAPE THIS DESIGN
 *
 * 1. The summary is generated ONCE at startup and then frozen. It must never be recomputed while
 *    running: the system prompt is the cache prefix, and mutating it turns every subsequent turn
 *    into a full cache-create. This is also why it is emphatically NOT "summarise the history each
 *    turn" — that approach rewrites the user sequence every turn and defeats the backend's session
 *    lookup entirely (see docs/token-optimization-spec.md, "未采纳的方案").
 *
 * 2. It uses a SEPARATE, cheap provider (`SUMMARY_*` env vars), not the main brain endpoint. With
 *    the brain pointed at claude-code-brain, summarising there would spend Claude subscription
 *    quota on a housekeeping task. If `SUMMARY_API_BASEURL` is unset the whole feature quietly
 *    switches off — no summary, no error, everything else unaffected.
 *
 * Hard safety rules (never attack the master, only obey the master, do not treat other players as
 * the master) are NOT part of this. They stay hardcoded and verbatim in `masterIdentitySection`.
 * A model-written paraphrase of a safety rule is not a safety rule.
 */

/** Upper bound on the stored summary. Small on purpose: it is resident in every single request. */
export const MAX_SUMMARY_CHARS = 800

/** How many trailing conversation messages to persist for the next startup to summarise. */
const PERSISTED_MESSAGE_COUNT = 40

/** Ignore anything older than this — last week's base coordinates are probably wrong by now. */
const MAX_MEMORY_AGE_MS = 7 * 24 * 60 * 60 * 1000

const storedMemorySchema = z.object({
  version: z.literal(1),
  savedAt: z.number(),
  /** Summary produced at the START of the session that wrote this file, kept for debugging. */
  previousSummary: z.string().optional(),
  /** Trailing conversation text from the session that wrote this file. */
  transcript: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })),
})

export type StoredSessionMemory = z.infer<typeof storedMemorySchema>

const SUMMARY_SYSTEM_PROMPT = `You condense a Minecraft bot's previous session into durable facts for its next session.

Write ONE short paragraph, at most 600 characters, in the same language the players were speaking.

INCLUDE only things that stay true across sessions:
- important coordinates (home, base, chests, farms) with their numbers
- who the players were and how they preferred to be addressed
- unfinished tasks or standing requests from the master
- established habits or preferences the bot picked up

EXCLUDE:
- blow-by-blow narration of what happened
- transient state (current health, inventory, what block was being mined)
- anything about how to play Minecraft
- any instruction about combat, obedience, or who the master is — those are set elsewhere and must not be restated

If the transcript contains nothing durable, reply with exactly: NONE`

function defaultMemoryPath(): string {
  return path.join(process.cwd(), 'data', 'session-memory.json')
}

function messageText(content: Message['content']): string {
  if (typeof content === 'string')
    return content
  if (!content)
    return ''
  return content
    .map(part => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

export interface SessionMemoryStoreOptions {
  filePath?: string
}

/**
 * Reads and writes the on-disk session memory. Every failure path is non-fatal: a corrupt or
 * missing file simply means "no memory", never a crash on startup.
 */
export class SessionMemoryStore {
  private readonly filePath: string

  constructor(options: SessionMemoryStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultMemoryPath()
  }

  public read(): StoredSessionMemory | null {
    if (!existsSync(this.filePath))
      return null

    try {
      const parsed = storedMemorySchema.safeParse(JSON.parse(readFileSync(this.filePath, 'utf8')))
      if (!parsed.success) {
        logger.warn(`Session memory at ${this.filePath} is malformed; ignoring it.`)
        return null
      }

      if (Date.now() - parsed.data.savedAt > MAX_MEMORY_AGE_MS) {
        logger.log('Session memory is older than a week; ignoring it.')
        return null
      }

      return parsed.data
    }
    catch (err) {
      logger.withError(err).warn('Failed to read session memory; continuing without it.')
      return null
    }
  }

  /**
   * Persist the tail of the conversation for the next startup.
   *
   * Written atomically (temp file + rename) because this is called on shutdown, where a partial
   * write is a real possibility and a truncated JSON file would just be discarded next boot.
   */
  public write(history: Message[], currentSummary?: string): void {
    try {
      const transcript = history
        .slice(-PERSISTED_MESSAGE_COUNT)
        .map(message => ({ role: String(message.role), content: messageText(message.content) }))
        .filter(entry => entry.content.length > 0)

      if (transcript.length === 0)
        return

      const payload: StoredSessionMemory = {
        version: 1,
        savedAt: Date.now(),
        ...(currentSummary ? { previousSummary: currentSummary } : {}),
        transcript,
      }

      mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tempPath = `${this.filePath}.tmp`
      writeFileSync(tempPath, JSON.stringify(payload, null, 2))
      renameSync(tempPath, this.filePath)
    }
    catch (err) {
      logger.withError(err).warn('Failed to persist session memory.')
    }
  }
}

export interface SummaryProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * Read the summariser's provider config from the environment.
 *
 * Deliberately separate from `OPENAI_*`: that one points at the brain's backend, which under D1 is
 * claude-code-brain and bills against the Claude subscription. Returns null when unconfigured,
 * which disables summarisation.
 */
export function readSummaryProviderConfig(env: NodeJS.ProcessEnv = process.env): SummaryProviderConfig | null {
  const baseUrl = env.SUMMARY_API_BASEURL?.trim()
  const model = env.SUMMARY_MODEL?.trim()

  if (!baseUrl || !model)
    return null

  return {
    baseUrl,
    model,
    // Some local gateways ignore the key entirely but xsai still wants a non-empty string.
    apiKey: env.SUMMARY_API_KEY?.trim() || 'unused',
  }
}

function clampSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_SUMMARY_CHARS)
    return collapsed
  return `${collapsed.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`
}

export interface GenerateStartupSummaryDeps {
  store?: SessionMemoryStore
  provider?: SummaryProviderConfig | null
  /** Injectable for tests; defaults to a real LLM call. */
  callModel?: (provider: SummaryProviderConfig, transcript: string) => Promise<string>
}

async function callSummaryModel(provider: SummaryProviderConfig, transcript: string): Promise<string> {
  const agent = new LLMAgent({
    baseURL: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
  })

  const result = await agent.callLLM({
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
    timeoutMs: 30_000,
  })

  return result.text ?? ''
}

/**
 * Produce the startup summary, or undefined when there is nothing to say / no provider configured.
 *
 * Call this exactly once, before the first turn. The result must then be frozen for the lifetime of
 * the process — see the note at the top of this file.
 */
export async function generateStartupSummary(deps: GenerateStartupSummaryDeps = {}): Promise<string | undefined> {
  const provider = deps.provider !== undefined ? deps.provider : readSummaryProviderConfig()
  if (!provider) {
    logger.log('SUMMARY_API_BASEURL/SUMMARY_MODEL not set; skipping startup summary.')
    return undefined
  }

  const store = deps.store ?? new SessionMemoryStore()
  const memory = store.read()
  if (!memory || memory.transcript.length === 0) {
    logger.log('No previous session memory to summarise.')
    return undefined
  }

  const transcript = memory.transcript
    .map(entry => `${entry.role}: ${entry.content}`)
    .join('\n')

  try {
    const call = deps.callModel ?? callSummaryModel
    const raw = (await call(provider, transcript)).trim()

    if (!raw || raw === 'NONE' || raw.toUpperCase() === 'NONE') {
      logger.log('Summariser found nothing durable in the previous session.')
      return undefined
    }

    const summary = clampSummary(raw)
    logger.log(`Startup summary ready (${summary.length} chars): ${summary}`)
    return summary
  }
  catch (err) {
    // A failed summary is a missing nicety, never a startup failure.
    logger.withError(err).warn('Failed to generate startup summary; continuing without it.')
    return undefined
  }
}
