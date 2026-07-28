import type { Logg } from '@guiiai/logg'
import type { Message } from '@xsai/shared-chat'

import type { AiriBridge } from '../../airi/airi-bridge'
import type { MinecraftContextService } from '../../airi/minecraft-context-service'
import type { ConversationUpdateEvent } from '../../debug/types'
import type { Action } from '../../libs/mineflayer/action'
import type { VisionFrame } from '../../vision/bot-camera'
import type { TaskExecutor } from '../action/task-executor'
import type { ActionInstruction } from '../action/types'
import type { EventBus, TracedEvent } from '../event-bus'
import type { PerceptionSignal } from '../perception/types/signals'
import type { ReflexManager } from '../reflex/reflex-manager'
import type { BotEvent, MineflayerWithAgents } from '../types'
import type { PlannerGlobalDescriptor } from './js-planner'
import type { ActionRuntimeResult } from './js-planner-sandbox-protocol'
import type { LLMAgent, LLMResult } from './llm-agent'
import type { LlmLogEntry, LlmLogEntryKind } from './llm-log'
import type { CancellationToken } from './task-state'

import { config } from '../../composables/config'
import { DebugService } from '../../debug'
import { ActionError } from '../../utils/errors'
import { hasPendingVisionFrame, takePendingVisionFrame } from '../../vision/bot-camera'
import { buildConsciousContextView } from './context-view'
import { createHistoryRuntime } from './history-query'
import { JavaScriptPlanner } from './js-planner'
import { createLlmLogRuntime } from './llm-log'
import {
  isLikelyAuthOrBadArgError,
  isRateLimitError,
  shouldRetryError,
  sleep,
  toErrorMessage,
} from './llmlogic'
import { PATTERN_CATALOG } from './patterns/catalog'
import { createPatternRuntime } from './patterns/runtime'
import { generateBrainSystemPrompt } from './prompts/brain-prompt'
import { normalizeReplScript } from './repl-code-normalizer'
import { generateStartupSummary, SessionMemoryStore } from './session-memory'
import { createCancellationToken } from './task-state'

interface BrainDeps {
  eventBus: EventBus
  llmAgent: LLMAgent
  logger: Logg
  taskExecutor: TaskExecutor
  reflexManager: ReflexManager
  airiBridge: AiriBridge
  minecraftContextService: MinecraftContextService
}

interface QueuedEvent {
  event: BotEvent
  resolve: () => void
  reject: (err: Error) => void
}

interface ReplOutcomeSummary {
  actionCount: number
  okCount: number
  errorCount: number
  returnValue?: string
  logs: string[]
  updatedAt: number
}

interface DebugReplResult {
  source: 'manual' | 'llm'
  code: string
  logs: string[]
  actions: Array<{
    tool: string
    params: Record<string, unknown>
    ok: boolean
    result?: string
    error?: string
  }>
  returnValue?: string
  error?: string
  durationMs: number
  timestamp: number
}

interface LlmInputSnapshot {
  systemPrompt: string
  userMessage: string
  messages: Message[]
  conversationHistory: Message[]
  updatedAt: number
  attempt: number
}

interface LlmTraceEntry {
  id: number
  turnId: number
  timestamp: number
  eventType: string
  sourceType: string
  sourceId: string
  attempt: number
  model: string
  // NOTICE: Full messages array is no longer stored to prevent O(turns²) memory growth.
  // Use messageCount + estimatedTokens for diagnostics, or llmLog for detailed history.
  messageCount: number
  estimatedTokens: number
  content: string
  reasoning?: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  durationMs: number
}

interface RuntimeInputEnvelope {
  id: number
  turnId: number
  timestamp: number
  event: {
    type: string
    sourceType: string
    sourceId: string
    payload: unknown
  }
  contextView: string
  userMessage: string
  systemPrompt: {
    preview: string
    length: number
  }
  llm?: {
    attempt: number
    model: string
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
    }
  }
}

type ActionQueueEntryState = 'pending' | 'executing' | 'succeeded' | 'failed' | 'cancelled'

interface ActionQueueEntryView {
  id: number
  tool: string
  params: Record<string, unknown>
  state: ActionQueueEntryState
  enqueuedAt: number
  sourceTurnId: number
  startedAt?: number
  finishedAt?: number
  result?: unknown
  error?: string
}

interface ActionQueueSnapshot {
  executing: ActionQueueEntryView | null
  pending: ActionQueueEntryView[]
  recent: ActionQueueEntryView[]
  capacity: {
    total: number
    executing: number
    pending: number
  }
  counts: {
    total: number
    executing: number
    pending: number
  }
  updatedAt: number
}

interface ControlActionQueueEntry {
  id: number
  action: ActionInstruction
  sourceTurnId: number
  state: ActionQueueEntryState
  enqueuedAt: number
  startedAt?: number
  finishedAt?: number
  result?: unknown
  error?: string
}

interface NoActionBudgetState {
  remaining: number
  default: number
  max: number
}

interface ErrorBurstGuardState {
  threshold: number
  windowTurns: number
  errorTurnCount: number
  recentTurnIds: number[]
  recentErrorSummary: string[]
  triggeredAtTurnId: number
}

function truncateForPrompt(value: string, maxLength = 220): string {
  // NOTICE: callers can pass undefined despite the `string` type — a successful action with no return
  // value hits `JSON.stringify(undefined) === undefined` upstream, which previously crashed the whole
  // brain turn here with "Cannot read properties of undefined (reading 'length')". Coerce defensively.
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`
}

function stringifyForLog(value: unknown): string {
  if (typeof value === 'string')
    return value
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

/**
 * Builds this turn's user message, carrying a rendered frame alongside the text when the bot took
 * one for itself.
 *
 * The image rides on the newest user message only. `claude-code-brain` forwards images from
 * messages after the last assistant turn (`services/claude-code-brain/src/translate.ts`), and the
 * plain-text form of this same message is what goes into `conversationHistory` — so a screenshot is
 * paid for once, on the turn that needs it, instead of being re-billed for the rest of the session.
 */
function buildUserTurnMessage(userMessage: string, frame: VisionFrame | null): Message {
  if (!frame)
    return { role: 'user', content: userMessage }

  const vantage = `[VISION] Rendered from your eyes at (${frame.vantage.x}, ${frame.vantage.y}, ${frame.vantage.z}), yaw ${frame.vantage.yaw}, pitch ${frame.vantage.pitch}. This is the only turn that carries this image.`

  return {
    role: 'user',
    content: [
      { type: 'text', text: `${userMessage}\n\n${vantage}` },
      { type: 'image_url', image_url: { url: frame.dataUrl } },
    ],
  }
}

const NO_ACTION_FOLLOWUP_SOURCE_ID = 'brain:no_action_followup'
const NO_ACTION_BUDGET_ALERT_SOURCE_ID = 'brain:no_action_budget'
const VISION_FOLLOWUP_SOURCE_ID = 'brain:vision_followup'

/**
 * How many looks in a row may each schedule their own follow-up turn.
 *
 * A look only pays off when the model then acts on what it saw. Without a cap, "look, decide to
 * look again" is a loop that bills an image every turn, so after this many consecutive
 * vision-triggered turns the pending frame is dropped and the model is told to act instead.
 */
const VISION_FOLLOWUP_STREAK_LIMIT = 3

/**
 * Priority tiers for event scheduling (lower = higher priority).
 * Player chat and AIRI commands always take precedence over stale system feedback.
 */
const EVENT_PRIORITY_URGENT_PERCEPTION = 0
const EVENT_PRIORITY_PERCEPTION = 1
const EVENT_PRIORITY_FEEDBACK = 2
const EVENT_PRIORITY_NO_ACTION_FOLLOWUP = 3
const MAX_QUEUED_CONTROL_ACTIONS = 5
const MAX_PENDING_CONTROL_ACTIONS = 4
const ACTION_QUEUE_RECENT_HISTORY_LIMIT = 20
const MAX_CONVERSATION_HISTORY_MESSAGES = 200

/**
 * How many messages to drop at once when history exceeds the cap.
 *
 * NOTICE: this exists to protect the backend's prompt cache, and the size is the whole point.
 *
 * `claude-code-brain` looks a session up by hashing the concatenated text of every user turn except
 * the newest (`services/claude-code-brain/src/sessions.ts`). Trimming two messages per turn — the
 * previous behaviour — changed the head of that user sequence on every single turn, so the hash
 * missed every time and the backend replayed the entire conversation fresh, forever, from the
 * moment history first hit the cap.
 *
 * Dropping a batch instead means the prefix stays byte-identical for roughly `TRIM_BATCH / 2` turns
 * (each turn appends one user + one assistant message), so all but one turn in twenty is a cache
 * hit. History length then oscillates between 160 and 200, which is expected and harmless.
 */
const CONVERSATION_HISTORY_TRIM_BATCH = 40

/** How often to checkpoint session memory to disk, in turns. */
const SESSION_MEMORY_CHECKPOINT_TURNS = 20

/**
 * Drop the oldest messages once history exceeds the cap, in batches.
 *
 * Exported so the cache-prefix property can be asserted directly: after a trim, the head of the
 * user sequence must stay byte-identical for many consecutive turns. That stability is the entire
 * mechanism by which the backend can resume a session instead of replaying it — see
 * CONVERSATION_HISTORY_TRIM_BATCH.
 */
export function trimConversationHistory(history: Message[]): Message[] {
  if (history.length <= MAX_CONVERSATION_HISTORY_MESSAGES)
    return history

  const overflow = history.length - MAX_CONVERSATION_HISTORY_MESSAGES
  const trimCount = Math.min(Math.max(overflow, CONVERSATION_HISTORY_TRIM_BATCH), history.length)
  return history.slice(trimCount)
}
const NO_ACTION_FOLLOWUP_BUDGET_DEFAULT = 3
const NO_ACTION_FOLLOWUP_BUDGET_MAX = 8
const NO_ACTION_STAGNATION_REPEAT_LIMIT = 2
const DEFAULT_LLM_ATTEMPT_TIMEOUT_MS = 60_000
const ERROR_BURST_GUARD_SOURCE_ID = 'brain:error_burst_guard'
const ERROR_BURST_THRESHOLD = 3
const ERROR_BURST_WINDOW_TURNS = 5
const MAX_EVENT_QUEUE_LENGTH = 256
const MAX_CONSECUTIVE_HIGH_PRIORITY_TURNS = 8
const PAUSE_ABORT_ERROR_NAME = 'AbortError'

/**
 * Turn a cryptic sandbox runtime error into actionable guidance the LLM can act on next turn.
 *
 * The dominant recurring failure is reading a coordinate (`.x`/`.y`/`.z`/`.pos`) off a query result
 * that was `null` — e.g. `query.entities().whereName("pig").first().pos.x` when no pig was found.
 * The raw message ("Cannot read properties of undefined (reading 'x')") gave the model nothing to
 * fix, so it would repeat the same crash for several turns and then give up. Appending the concrete
 * fix lets it recover in one turn.
 *
 * Before:
 * - "Cannot read properties of undefined (reading 'x')"
 * After:
 * - "...reading 'x') — 你读取了不存在对象的坐标。query 的 .first() 找不到时是 null,先判空… "
 */
function augmentDecisionError(message: string): string {
  if (/Cannot read properties of (?:undefined|null) \(reading '(?:[xyz]|pos|position|location)'\)/.test(message)) {
    return `${message} — 你读取了一个不存在对象的坐标。query.entities()/query.blocks() 的 .first() 在没找到目标时返回 null,直接读它的 .pos/.x 就会这样崩。修法:先判空再读,例如 const t = query.entities().whereName("pig").first(); if (!t) { await chat({ message: "附近没有目标,我换个方向找找", feedback: false }) } else { await goToCoordinate({ x: t.pos.x, y: t.pos.y, z: t.pos.z, closeness: 1 }) }。提示:杀动物直接用 attack({ type: "pig" }) 击杀最近的,通常根本不用手动查坐标。`
  }
  return message
}

function getEventPriority(event: BotEvent): number {
  if (event.type === 'perception') {
    const signal = event.payload as PerceptionSignal
    if (signal.type === 'chat_message' || signal.type === 'airi_command')
      return EVENT_PRIORITY_URGENT_PERCEPTION
    return EVENT_PRIORITY_PERCEPTION
  }
  if (event.source.type === 'system' && event.source.id === NO_ACTION_FOLLOWUP_SOURCE_ID)
    return EVENT_PRIORITY_NO_ACTION_FOLLOWUP
  if (event.type === 'feedback')
    return EVENT_PRIORITY_FEEDBACK
  return EVENT_PRIORITY_PERCEPTION
}

export class Brain {
  private debugService: DebugService
  private readonly repl = new JavaScriptPlanner()
  private paused = false

  // State
  private queue: QueuedEvent[] = []
  private consecutiveHighPriorityTurns = 0
  private isProcessing = false
  private isReplEvaluating = false
  private currentCancellationToken: CancellationToken | undefined
  private currentLlmAbortController: AbortController | null = null
  private givenUp = false
  private giveUpReason: string | undefined
  private lastContextView: string | undefined
  private lastReplOutcome: ReplOutcomeSummary | undefined
  private conversationHistory: Message[] = []
  /**
   * Durable facts recovered from the previous session, resolved once at startup and then immutable.
   * See `loadStartupSummary`.
   */
  private startupSummary: string | undefined
  private startupSummaryLoaded = false
  private readonly sessionMemoryStore = new SessionMemoryStore()
  private lastLlmInputSnapshot: LlmInputSnapshot | null = null
  private runtimeMineflayer: MineflayerWithAgents | null = null
  private readonly llmLogEntries: LlmLogEntry[] = []
  private llmLogIdCounter = 0
  private readonly llmTraceEntries: LlmTraceEntry[] = []
  private llmTraceIdCounter = 0
  private turnCounter = 0
  private currentInputEnvelope: RuntimeInputEnvelope | null = null
  private readonly llmLogRuntime = createLlmLogRuntime(() => this.llmLogEntries)
  private readonly patternRuntime = createPatternRuntime(PATTERN_CATALOG)
  private readonly historyRuntime = createHistoryRuntime({
    getConversationHistory: () => this.conversationHistory,
    getLlmLogEntries: () => this.llmLogEntries,
    getCurrentTurnId: () => this.turnCounter,
  })

  private nextControlActionId = 0
  private pendingControlActions: ControlActionQueueEntry[] = []
  private activeControlAction: ControlActionQueueEntry | null = null
  private recentControlActions: ControlActionQueueEntry[] = []
  private readonly stopCancelledControlActionIds = new Set<number>()
  private actionQueueUpdatedAt = Date.now()
  private isActionWorkerRunning = false
  private completedControlActionsSinceLastFeedback = 0
  private noActionFollowupBudgetRemaining = NO_ACTION_FOLLOWUP_BUDGET_DEFAULT
  private noActionFollowupLastSignature: string | null = null
  private noActionFollowupStagnationCount = 0
  /** Consecutive turns that were themselves triggered by a look; see {@link VISION_FOLLOWUP_STREAK_LIMIT}. */
  private visionFollowupStreak = 0
  private errorBurstGuardState: ErrorBurstGuardState | null = null
  private errorBurstGuardSuppressUntilTurnId = 0
  private unsubscribeEventBus: (() => void) | null = null
  private onActionCompleted: ((...args: any[]) => void) | null = null
  private onActionFailed: ((...args: any[]) => void) | null = null

  constructor(private readonly deps: BrainDeps) {
    this.debugService = DebugService.getInstance()
  }

  /**
   * Load the previous session's durable facts and freeze them into the system prompt.
   *
   * Fire-and-forget by design: the bot must be able to start and act while the summariser is still
   * thinking. Turns taken before it lands simply have no summary, which is the same as today's
   * behaviour. Once assigned, `startupSummary` never changes again — the system prompt is the
   * backend's cache prefix, and rewriting it mid-session would force a full cache-create every turn.
   */
  private async loadStartupSummary(): Promise<void> {
    if (this.startupSummaryLoaded)
      return
    this.startupSummaryLoaded = true

    try {
      const summary = await generateStartupSummary({ store: this.sessionMemoryStore })
      if (!summary)
        return

      this.startupSummary = summary
      this.deps.logger.log('INFO', `Brain: Loaded startup summary from previous session (${summary.length} chars).`)
    }
    catch (err) {
      this.deps.logger.withError(err as Error).warn('Brain: Startup summary unavailable; continuing without it.')
    }
  }

  /**
   * Write the tail of this session's conversation to disk for the next startup to summarise.
   */
  public persistSessionMemory(): void {
    this.sessionMemoryStore.write(this.conversationHistory, this.startupSummary)
  }

  public init(bot: MineflayerWithAgents): void {
    this.deps.logger.log('INFO', 'Brain: Initializing stateful core...')
    this.runtimeMineflayer = bot

    void this.loadStartupSummary()

    // Perception Handler
    this.unsubscribeEventBus = this.deps.eventBus.subscribe<PerceptionSignal>('conscious:signal:*', (event: TracedEvent<PerceptionSignal>) => {
      // AIRI context updates are injected into conversation history without triggering a full cognitive cycle
      if (event.payload.type === 'airi_context') {
        this.conversationHistory.push({
          role: 'user',
          content: `[AIRI_CONTEXT] ${event.payload.description}`,
        })
        this.deps.logger.log('INFO', `Brain: Injected AIRI context: ${event.payload.description.slice(0, 80)}`)
        return
      }

      this.enqueueEvent(bot, {
        type: 'perception',
        payload: event.payload,
        source: { type: event.payload.sourceId === 'airi' ? 'airi' : 'minecraft', id: event.payload.sourceId ?? 'perception' },
        timestamp: Date.now(),
      }).catch(err => this.deps.logger.withError(err).error('Brain: Failed to process perception event'))
    })

    // Action telemetry logger
    this.onActionCompleted = async ({ action, result }: { action: ActionInstruction, result: unknown }) => {
      this.deps.logger.log('INFO', `Brain: Action completed: ${action.tool}`)
      this.appendLlmLog({
        turnId: this.turnCounter,
        kind: 'feedback',
        eventType: 'feedback',
        sourceType: 'system',
        sourceId: 'executor',
        tags: ['feedback', 'success', action.tool],
        text: `Action completed: ${action.tool}`,
        metadata: {
          params: action.params,
          result: stringifyForLog(result),
        },
      })

      if (action.tool === 'chat' && action.params?.feedback !== true) {
        return
      }

      if (action.tool === 'giveUp') {
        this.givenUp = true
        this.giveUpReason = typeof action.params?.reason === 'string' ? action.params.reason : undefined

        try {
          const reason = this.giveUpReason ? `: ${this.giveUpReason}` : ''
          bot.bot.chat(`[debug] Gave up${reason}. Waiting for player input.`)
        }
        catch (err) {
          this.deps.logger.withError(err as Error).warn('Brain: Failed to announce giveUp to chat')
        }
      }

      if (action.tool === 'chat' && action.params?.feedback === true) {
        this.enqueueEvent(bot, {
          type: 'feedback',
          payload: { status: 'success', action, result },
          source: { type: 'system', id: 'executor' },
          timestamp: Date.now(),
        }).catch(err => this.deps.logger.withError(err).error('Brain: Failed to process chat feedback'))
      }
    }
    this.deps.taskExecutor.on('action:completed', this.onActionCompleted)

    this.onActionFailed = async ({ action, error }: { action: ActionInstruction, error: Error }) => {
      this.deps.logger.withError(error).warn(`Brain: Action failed: ${action.tool}`)
      this.appendLlmLog({
        turnId: this.turnCounter,
        kind: 'feedback',
        eventType: 'feedback',
        sourceType: 'system',
        sourceId: 'executor',
        tags: ['feedback', 'error', action.tool],
        text: `Action failed: ${action.tool}: ${error?.message || String(error)}`,
        metadata: {
          params: action.params,
        },
      })
    }
    this.deps.taskExecutor.on('action:failed', this.onActionFailed)

    this.deps.logger.log('INFO', 'Brain: Online.')

    this.deps.minecraftContextService.bindBot(bot)
  }

  public destroy(): void {
    // Save before tearing anything down, so a restart can pick the thread back up.
    this.persistSessionMemory()
    this.deps.minecraftContextService.unbindBot()
    if (this.unsubscribeEventBus) {
      this.unsubscribeEventBus()
      this.unsubscribeEventBus = null
    }
    if (this.onActionCompleted) {
      this.deps.taskExecutor.off('action:completed', this.onActionCompleted)
      this.onActionCompleted = null
    }
    if (this.onActionFailed) {
      this.deps.taskExecutor.off('action:failed', this.onActionFailed)
      this.onActionFailed = null
    }
    this.cancelInFlightLlm('Brain destroyed')
    this.currentCancellationToken?.cancel()
    this.clearPendingControlActions('cancelled')
    this.activeControlAction = null
    this.stopCancelledControlActionIds.clear()
    this.touchActionQueue()
    this.runtimeMineflayer = null
  }

  public getReplState(options: { includeBuiltins?: boolean } = {}): { variables: PlannerGlobalDescriptor[], updatedAt: number, paused: boolean } {
    const snapshot = this.deps.reflexManager.getContextSnapshot()
    const replEvent: BotEvent = {
      type: 'system_alert',
      payload: { source: 'debug-repl-state' },
      source: { type: 'system', id: 'debug-repl' },
      timestamp: Date.now(),
    }
    const variables = this.repl.describeGlobals(
      this.deps.taskExecutor.getAvailableActions(),
      this.createRuntimeGlobals(replEvent, snapshot as unknown as Record<string, unknown>),
      { includeBuiltins: options.includeBuiltins },
    )

    return {
      variables,
      updatedAt: Date.now(),
      paused: this.paused,
    }
  }

  public getDebugSnapshot(): {
    isProcessing: boolean
    queueLength: number
    actionQueue: ActionQueueSnapshot
    turnCounter: number
    givenUp: boolean
    paused: boolean
    contextView: string | undefined
    conversationHistory: Message[]
    llmLogEntries: LlmLogEntry[]
  } {
    return {
      isProcessing: this.isProcessing,
      queueLength: this.queue.length,
      actionQueue: this.getActionQueueSnapshot(),
      turnCounter: this.turnCounter,
      givenUp: this.givenUp,
      paused: this.paused,
      contextView: this.lastContextView,
      conversationHistory: this.cloneMessages(this.conversationHistory),
      llmLogEntries: [...this.llmLogEntries],
    }
  }

  public setPaused(paused: boolean): boolean {
    this.paused = paused
    if (paused)
      this.cancelInFlightLlm('Brain paused')
    return this.paused
  }

  public togglePaused(): boolean {
    return this.setPaused(!this.paused)
  }

  public isPaused(): boolean {
    return this.paused
  }

  public getLastLlmInput(): LlmInputSnapshot | null {
    if (!this.lastLlmInputSnapshot)
      return null
    return JSON.parse(JSON.stringify(this.lastLlmInputSnapshot)) as LlmInputSnapshot
  }

  public getLlmLogs(limit?: number): LlmLogEntry[] {
    const entries = [...this.llmLogEntries]
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0)
      return entries
    return entries.slice(-Math.floor(limit))
  }

  public getLlmTrace(limit?: number, turnId?: number): LlmTraceEntry[] {
    let entries = [...this.llmTraceEntries]
    if (typeof turnId === 'number' && Number.isFinite(turnId)) {
      const normalizedTurnId = Math.floor(turnId)
      entries = entries.filter(entry => entry.turnId === normalizedTurnId)
    }

    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      entries = entries.slice(-Math.floor(limit))
    }

    return JSON.parse(JSON.stringify(entries)) as LlmTraceEntry[]
  }

  private cancelInFlightLlm(reason: string): void {
    if (!this.currentLlmAbortController)
      return
    if (!this.currentLlmAbortController.signal.aborted) {
      const abortError = Object.assign(new Error(reason), { name: 'AbortError' })
      this.currentLlmAbortController.abort(abortError)
    }
    this.currentLlmAbortController = null
  }

  private async callLLM(messages: Message[]): Promise<LLMResult> {
    const abortController = new AbortController()

    this.currentLlmAbortController = abortController
    try {
      return await this.deps.llmAgent.callLLM({
        messages,
        abortSignal: abortController.signal,
        timeoutMs: DEFAULT_LLM_ATTEMPT_TIMEOUT_MS,
      })
    }
    finally {
      if (this.currentLlmAbortController === abortController)
        this.currentLlmAbortController = null
    }
  }

  private isAbortError(err: unknown): boolean {
    if (!err || typeof err !== 'object')
      return false
    return (err as { name?: unknown }).name === PAUSE_ABORT_ERROR_NAME
  }

  public forgetConversation(): { ok: true, cleared: string[] } {
    this.conversationHistory = []
    this.lastLlmInputSnapshot = null
    this.emitConversationUpdate(false, true)
    return {
      ok: true,
      cleared: ['conversationHistory', 'lastLlmInputSnapshot'],
    }
  }

  public async injectDebugEvent(event: BotEvent): Promise<void> {
    if (!this.runtimeMineflayer) {
      throw new Error('Brain runtime is not initialized yet')
    }

    // Debug-injected perception events bypass the normal Reflex signal path.
    // Refresh context from live bot state first so conscious prompts don't use
    // stale/default environment placeholders.
    if (event.type === 'perception') {
      try {
        this.deps.reflexManager.refreshFromBotState()
      }
      catch (err) {
        this.deps.logger.withError(err as Error).warn('Brain: Failed to refresh reflex context for debug event')
      }
    }

    await this.enqueueEvent(this.runtimeMineflayer, event)
  }

  public async executeDebugRepl(code: string): Promise<DebugReplResult> {
    const startedAt = Date.now()
    if (this.isProcessing || this.isReplEvaluating) {
      return {
        source: 'manual',
        code,
        logs: [],
        actions: [],
        error: 'Brain is currently processing an event. Try again in a moment.',
        durationMs: Date.now() - startedAt,
        timestamp: Date.now(),
      }
    }

    const snapshot = this.deps.reflexManager.getContextSnapshot()
    const actionDefs = new Map(this.deps.taskExecutor.getAvailableActions().map(action => [action.name, action]))
    const normalizedReplCode = this.normalizeReplCode(code)
    const codeToEvaluate = this.repl.canEvaluateAsExpression(normalizedReplCode)
      ? `return (\n${normalizedReplCode}\n)`
      : normalizedReplCode

    this.isReplEvaluating = true
    try {
      const runResult = await this.repl.evaluate(
        codeToEvaluate,
        this.deps.taskExecutor.getAvailableActions(),
        this.createRuntimeGlobals({
          type: 'system_alert',
          payload: { source: 'debug-repl' },
          source: { type: 'system', id: 'debug-repl' },
          timestamp: Date.now(),
        }, snapshot as unknown as Record<string, unknown>),
        async (action: ActionInstruction) => {
          const actionDef = actionDefs.get(action.tool)
          if (actionDef?.followControl === 'detach')
            this.deps.reflexManager.clearFollowTarget()
          return this.deps.taskExecutor.executeActionWithResult(action)
        },
      )

      return {
        source: 'manual',
        code,
        logs: runResult.logs,
        actions: this.toDebugReplActions(runResult.actions),
        returnValue: runResult.returnValue,
        durationMs: Date.now() - startedAt,
        timestamp: Date.now(),
      }
    }
    catch (err) {
      return {
        source: 'manual',
        code,
        logs: [],
        actions: [],
        error: toErrorMessage(err),
        durationMs: Date.now() - startedAt,
        timestamp: Date.now(),
      }
    }
    finally {
      this.isReplEvaluating = false
    }
  }

  private normalizeReplCode(code: string): string {
    return normalizeReplScript(code)
  }

  private toDebugReplActions(actions: Array<{
    action: ActionInstruction
    ok: boolean
    result?: unknown
    error?: string
  }>): DebugReplResult['actions'] {
    return actions.map(item => ({
      tool: item.action.tool,
      params: item.action.params,
      ok: item.ok,
      result: item.result === undefined ? undefined : (typeof item.result === 'string' ? item.result : JSON.stringify(item.result)),
      error: item.error,
    }))
  }

  private cloneMessages(messages: Message[]): Message[] {
    return JSON.parse(JSON.stringify(messages)) as Message[]
  }

  // FIXME: Temporary fix to normalize xsai Message[] into the debug dashboard's string-only message schema.
  private toDebugConversationMessages(messages: Message[]): ConversationUpdateEvent['messages'] {
    return messages.map((message) => {
      const normalizedMessage: ConversationUpdateEvent['messages'][number] = {
        role: message.role,
        content: this.toDebugMessageContent(message.content),
      }
      const reasoning = this.extractMessageReasoning(message)
      if (reasoning)
        normalizedMessage.reasoning = reasoning
      return normalizedMessage
    })
  }

  // FIXME: Temporary fix to flatten structured message parts into a string for debug transport compatibility.
  private toDebugMessageContent(content: Message['content']): string {
    if (typeof content === 'string')
      return content
    if (!content)
      return ''
    return content
      .map((part) => {
        if (part.type === 'text')
          return part.text
        if (part.type === 'refusal')
          return part.refusal
        return JSON.stringify(part)
      })
      .join('\n')
  }

  // FIXME: Temporary fix to preserve reasoning in debug payload while message typing is inconsistent.
  private extractMessageReasoning(message: Message): string | undefined {
    const maybeReasoning = (message as Message & { reasoning?: unknown }).reasoning
    if (typeof maybeReasoning === 'string' && maybeReasoning.length > 0)
      return maybeReasoning
    if ('reasoning_content' in message && typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0)
      return message.reasoning_content
    return undefined
  }

  /**
   * Re-emit the current conversation state for the debug dashboard.
   * Used by the debug dashboard's `request_conversation` handler on reconnect.
   */
  public broadcastConversationState(): void {
    this.emitConversationUpdate(this.isProcessing)
  }

  private emitConversationUpdate(isProcessing: boolean, sessionBoundary?: boolean): void {
    this.debugService.emitConversationUpdate({
      messages: this.toDebugConversationMessages(this.cloneMessages(this.conversationHistory)),
      isProcessing,
      ...(sessionBoundary && { sessionBoundary }),
    })
  }

  private createRuntimeGlobals(
    event: BotEvent,
    snapshot: Record<string, unknown>,
    mineflayerOverride?: MineflayerWithAgents | null,
  ) {
    const mineflayer = mineflayerOverride ?? this.runtimeMineflayer
    return {
      event,
      snapshot,
      patterns: this.patternRuntime,
      mineflayer,
      bot: mineflayer?.bot,
      llmInput: this.lastLlmInputSnapshot,
      currentInput: this.currentInputEnvelope,
      llmLog: this.llmLogRuntime,
      actionQueue: this.getActionQueueSnapshot(),
      noActionBudget: this.getNoActionBudgetState(),
      errorBurstGuard: this.errorBurstGuardState ? { ...this.errorBurstGuardState } : null,
      setNoActionBudget: (value: number) => this.setNoActionFollowupBudget(value),
      getNoActionBudget: () => this.getNoActionBudgetState(),
      forgetConversation: () => this.forgetConversation(),
      history: this.historyRuntime,
      notifyAiri: (headline: string, note?: string, urgency?: 'immediate' | 'soon' | 'later') =>
        this.deps.airiBridge.sendNotify(headline, note, urgency),
      updateAiriContext: (text: string, hints?: string[], lane?: string) =>
        this.deps.airiBridge.sendContextUpdate(text, hints, lane),
    }
  }

  private isPlayerChatEvent(event: BotEvent): boolean {
    if (event.type !== 'perception')
      return false
    const signal = event.payload as PerceptionSignal
    return signal.type === 'chat_message'
  }

  private isAiriCommandEvent(event: BotEvent): boolean {
    if (event.type !== 'perception')
      return false
    const signal = event.payload as PerceptionSignal
    return signal.type === 'airi_command'
  }

  private getNoActionBudgetState(): NoActionBudgetState {
    return {
      remaining: this.noActionFollowupBudgetRemaining,
      default: NO_ACTION_FOLLOWUP_BUDGET_DEFAULT,
      max: NO_ACTION_FOLLOWUP_BUDGET_MAX,
    }
  }

  private resetNoActionFollowupBudget(reason: 'player_chat' | 'manual' | 'airi_command'): NoActionBudgetState {
    this.noActionFollowupBudgetRemaining = NO_ACTION_FOLLOWUP_BUDGET_DEFAULT
    this.noActionFollowupLastSignature = null
    this.noActionFollowupStagnationCount = 0
    this.appendLlmLog({
      turnId: this.turnCounter,
      kind: 'scheduler',
      eventType: 'system_alert',
      sourceType: 'system',
      sourceId: 'brain:no_action_budget',
      tags: ['scheduler', 'no_action', 'budget_reset', reason],
      text: `No-action follow-up budget reset (${reason})`,
      metadata: {
        budget: this.getNoActionBudgetState(),
      },
    })
    return this.getNoActionBudgetState()
  }

  private setNoActionFollowupBudget(value: number): { ok: true } & NoActionBudgetState {
    const normalizedRaw = Number(value)
    const normalized = Number.isFinite(normalizedRaw)
      ? Math.floor(normalizedRaw)
      : this.noActionFollowupBudgetRemaining
    const clamped = Math.max(0, Math.min(NO_ACTION_FOLLOWUP_BUDGET_MAX, normalized))
    this.noActionFollowupBudgetRemaining = clamped
    this.noActionFollowupLastSignature = null
    this.noActionFollowupStagnationCount = 0

    this.appendLlmLog({
      turnId: this.turnCounter,
      kind: 'scheduler',
      eventType: 'system_alert',
      sourceType: 'system',
      sourceId: 'brain:no_action_budget',
      tags: ['scheduler', 'no_action', 'budget_set'],
      text: `No-action follow-up budget set to ${clamped}`,
      metadata: {
        requested: value,
        budget: this.getNoActionBudgetState(),
      },
    })

    return {
      ok: true,
      ...this.getNoActionBudgetState(),
    }
  }

  private buildNoActionSignature(returnValue: string | undefined, logs: string[]): string {
    const returnPart = truncateForPrompt(returnValue ?? 'undefined', 320)
    const logsPart = logs.slice(-3).map(line => truncateForPrompt(line, 140)).join('|')
    return `${returnPart}||${logsPart}`
  }

  private emitNoActionBudgetDebugChat(
    bot: MineflayerWithAgents,
    reason: 'no_action_budget_exhausted' | 'no_action_stagnated',
  ): void {
    const message = reason === 'no_action_budget_exhausted'
      ? `[debug] no-action follow-up budget exhausted (remaining=0).`
      : `[debug] no-action follow-up blocked due to stagnant eval loop.`

    try {
      bot.bot.chat(message)
    }
    catch (err) {
      this.deps.logger.withError(err as Error).warn('Brain: Failed to send no-action budget debug chat')
    }
  }

  private isErrorLlmLogEntry(entry: LlmLogEntry): boolean {
    if (entry.kind === 'repl_error')
      return true

    if (entry.kind === 'repl_result') {
      const errorCount = Number((entry.metadata as Record<string, unknown> | undefined)?.errorCount ?? 0)
      return Number.isFinite(errorCount) && errorCount > 0
    }

    if (entry.kind === 'feedback') {
      const tags = new Set(entry.tags.map(tag => tag.toLowerCase()))
      return tags.has('error') || tags.has('failure')
    }

    return false
  }

  private describeErrorLlmLogEntry(entry: LlmLogEntry): string {
    return `${entry.kind}: ${truncateForPrompt(entry.text, 140)}`
  }

  private collectRecentErrorTurns(windowTurns = ERROR_BURST_WINDOW_TURNS): {
    recentTurnIds: number[]
    errorTurnIds: number[]
    summaries: string[]
  } {
    const turnIds: number[] = []
    const seen = new Set<number>()

    for (let index = this.llmLogEntries.length - 1; index >= 0; index--) {
      const entry = this.llmLogEntries[index]
      if (!entry || entry.kind !== 'turn_input')
        continue
      if (seen.has(entry.turnId))
        continue
      seen.add(entry.turnId)
      turnIds.push(entry.turnId)
      if (turnIds.length >= windowTurns)
        break
    }

    const entriesByTurnId = new Map<number, LlmLogEntry[]>()
    for (const turnId of turnIds)
      entriesByTurnId.set(turnId, [])

    for (const entry of this.llmLogEntries) {
      const bucket = entriesByTurnId.get(entry.turnId)
      if (!bucket)
        continue
      bucket.push(entry)
    }

    const errorTurnIds: number[] = []
    const summaries: string[] = []
    for (const turnId of turnIds) {
      const turnEntries = entriesByTurnId.get(turnId) ?? []
      const errors = turnEntries.filter(entry => this.isErrorLlmLogEntry(entry))
      if (errors.length === 0)
        continue
      errorTurnIds.push(turnId)
      const evidence = errors.slice(0, 2).map(entry => this.describeErrorLlmLogEntry(entry)).join(' | ')
      summaries.push(`turn=${turnId} ${evidence}`)
    }

    return {
      recentTurnIds: turnIds,
      errorTurnIds,
      summaries,
    }
  }

  private maybeActivateErrorBurstGuard(
    bot: MineflayerWithAgents,
    event: BotEvent,
    turnId: number,
  ): void {
    if (this.errorBurstGuardState)
      return

    if (turnId <= this.errorBurstGuardSuppressUntilTurnId)
      return

    const { recentTurnIds, errorTurnIds, summaries } = this.collectRecentErrorTurns(ERROR_BURST_WINDOW_TURNS)
    if (errorTurnIds.length < ERROR_BURST_THRESHOLD)
      return

    const recentErrorSummary = summaries.slice(0, ERROR_BURST_WINDOW_TURNS)
    this.errorBurstGuardState = {
      threshold: ERROR_BURST_THRESHOLD,
      windowTurns: ERROR_BURST_WINDOW_TURNS,
      errorTurnCount: errorTurnIds.length,
      recentTurnIds,
      recentErrorSummary,
      triggeredAtTurnId: turnId,
    }

    this.appendLlmLog({
      turnId,
      kind: 'scheduler',
      eventType: 'system_alert',
      sourceType: 'system',
      sourceId: ERROR_BURST_GUARD_SOURCE_ID,
      tags: ['scheduler', 'error_burst', 'guard_triggered', 'error'],
      text: `Error burst guard activated (${errorTurnIds.length}/${Math.max(recentTurnIds.length, ERROR_BURST_WINDOW_TURNS)} recent turns contain errors)`,
      metadata: {
        threshold: ERROR_BURST_THRESHOLD,
        windowTurns: ERROR_BURST_WINDOW_TURNS,
        errorTurnIds,
        recentErrorSummary,
      },
    })

    if (event.source.type === 'system' && event.source.id === ERROR_BURST_GUARD_SOURCE_ID)
      return

    void this.enqueueEvent(bot, {
      type: 'system_alert',
      payload: {
        reason: 'error_burst_guard',
        threshold: ERROR_BURST_THRESHOLD,
        windowTurns: ERROR_BURST_WINDOW_TURNS,
        errorTurnCount: errorTurnIds.length,
        recentErrorSummary,
        guidance: 'Too many recent errors. Call giveUp(...) and send one chat explanation.',
      },
      source: { type: 'system', id: ERROR_BURST_GUARD_SOURCE_ID },
      timestamp: Date.now(),
    }).catch(err => this.deps.logger.withError(err).error('Brain: Failed to enqueue error-burst guard alert'))
  }

  private clearErrorBurstGuardState(turnId: number, reason: 'resolved' | 'manual'): void {
    if (!this.errorBurstGuardState)
      return

    this.appendLlmLog({
      turnId,
      kind: 'scheduler',
      eventType: 'system_alert',
      sourceType: 'system',
      sourceId: ERROR_BURST_GUARD_SOURCE_ID,
      tags: ['scheduler', 'error_burst', 'guard_cleared', reason],
      text: `Error burst guard cleared (${reason})`,
      metadata: {
        guard: { ...this.errorBurstGuardState },
      },
    })

    this.errorBurstGuardSuppressUntilTurnId = turnId + ERROR_BURST_WINDOW_TURNS
    this.errorBurstGuardState = null
  }

  private updateErrorBurstGuardCompletion(
    turnId: number,
    actions: Array<{
      action: ActionInstruction
      ok: boolean
    }>,
  ): void {
    if (!this.errorBurstGuardState)
      return

    const hasGiveUp = actions.some(item => item.action.tool === 'giveUp' && item.ok)
    const hasChat = actions.some(item => item.action.tool === 'chat' && item.ok)

    if (hasGiveUp && hasChat) {
      this.clearErrorBurstGuardState(turnId, 'resolved')
      return
    }

    if (hasGiveUp || hasChat) {
      this.appendLlmLog({
        turnId,
        kind: 'scheduler',
        eventType: 'system_alert',
        sourceType: 'system',
        sourceId: ERROR_BURST_GUARD_SOURCE_ID,
        tags: ['scheduler', 'error_burst', 'guard_pending'],
        text: 'Error burst guard still pending: this turn must include both giveUp and chat actions',
      })
    }
  }

  private appendLlmLog(entry: {
    turnId: number
    kind: LlmLogEntryKind
    eventType: string
    sourceType: string
    sourceId: string
    tags?: string[]
    text: string
    metadata?: Record<string, unknown>
  }): void {
    const normalized: LlmLogEntry = {
      id: ++this.llmLogIdCounter,
      turnId: entry.turnId,
      kind: entry.kind,
      timestamp: Date.now(),
      eventType: entry.eventType,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      tags: entry.tags ?? [],
      text: entry.text,
      metadata: entry.metadata,
    }

    this.llmLogEntries.push(normalized)
    if (this.llmLogEntries.length > 1000) {
      this.llmLogEntries.shift()
    }
  }

  private touchActionQueue(): void {
    this.actionQueueUpdatedAt = Date.now()
  }

  private cloneActionParams(params: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(params)) as Record<string, unknown>
  }

  private toActionQueueEntryView(entry: ControlActionQueueEntry): ActionQueueEntryView {
    return {
      id: entry.id,
      tool: entry.action.tool,
      params: this.cloneActionParams(entry.action.params),
      state: entry.state,
      enqueuedAt: entry.enqueuedAt,
      sourceTurnId: entry.sourceTurnId,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      result: entry.result,
      error: entry.error,
    }
  }

  private pushRecentControlAction(entry: ControlActionQueueEntry): void {
    this.recentControlActions.push({
      ...entry,
      action: {
        tool: entry.action.tool,
        params: this.cloneActionParams(entry.action.params),
      },
    })
    if (this.recentControlActions.length > ACTION_QUEUE_RECENT_HISTORY_LIMIT) {
      this.recentControlActions.shift()
    }
  }

  private getActionQueueSnapshot(): ActionQueueSnapshot {
    const executing = this.activeControlAction ? this.toActionQueueEntryView(this.activeControlAction) : null
    const pending = this.pendingControlActions.map(entry => this.toActionQueueEntryView(entry))
    const recent = this.recentControlActions.map(entry => this.toActionQueueEntryView(entry))
    const executingCount = executing ? 1 : 0
    const pendingCount = pending.length

    return {
      executing,
      pending,
      recent,
      capacity: {
        total: MAX_QUEUED_CONTROL_ACTIONS,
        executing: 1,
        pending: MAX_PENDING_CONTROL_ACTIONS,
      },
      counts: {
        total: executingCount + pendingCount,
        executing: executingCount,
        pending: pendingCount,
      },
      updatedAt: this.actionQueueUpdatedAt,
    }
  }

  private isQueueConsumingControlAction(action: ActionInstruction, actionDef: Action | undefined): boolean {
    if (action.tool === 'chat' || action.tool === 'skip' || action.tool === 'stop')
      return false

    if (!actionDef)
      return false

    if (actionDef?.readonly)
      return false

    return actionDef.execution === 'async'
  }

  private clearPendingControlActions(state: Extract<ActionQueueEntryState, 'cancelled' | 'failed'>): number {
    if (this.pendingControlActions.length === 0)
      return 0

    const clearedAt = Date.now()
    const cleared = this.pendingControlActions.splice(0, this.pendingControlActions.length)
    for (const entry of cleared) {
      entry.state = state
      entry.finishedAt = clearedAt
      entry.error = state === 'failed' ? entry.error : entry.error ?? 'Cleared from action queue'
      this.pushRecentControlAction(entry)
    }
    this.touchActionQueue()
    return cleared.length
  }

  private async enqueueControlAction(
    bot: MineflayerWithAgents,
    action: ActionInstruction,
    sourceTurnId: number,
  ): Promise<unknown> {
    const queueSize = this.pendingControlActions.length + (this.activeControlAction ? 1 : 0)
    if (queueSize >= MAX_QUEUED_CONTROL_ACTIONS) {
      throw new Error(`Action queue full (${queueSize}/${MAX_QUEUED_CONTROL_ACTIONS}). Use stop() or wait for completion.`)
    }

    const entry: ControlActionQueueEntry = {
      id: ++this.nextControlActionId,
      action: {
        tool: action.tool,
        params: this.cloneActionParams(action.params),
      },
      sourceTurnId,
      state: 'pending',
      enqueuedAt: Date.now(),
    }
    this.pendingControlActions.push(entry)
    this.touchActionQueue()

    this.appendLlmLog({
      turnId: sourceTurnId,
      kind: 'scheduler',
      eventType: 'system_alert',
      sourceType: 'system',
      sourceId: 'brain:action_queue',
      tags: ['scheduler', 'action_queue', 'enqueued'],
      text: `Queued control action #${entry.id}: ${entry.action.tool}`,
      metadata: {
        actionId: entry.id,
        pendingCount: this.pendingControlActions.length,
      },
    })

    this.startControlActionWorker(bot)
    return {
      queued: true,
      actionId: entry.id,
      state: entry.state,
      pendingAhead: Math.max(0, this.pendingControlActions.length - 1),
      queue: this.getActionQueueSnapshot().counts,
    }
  }

  private startControlActionWorker(bot: MineflayerWithAgents): void {
    if (this.isActionWorkerRunning)
      return

    this.isActionWorkerRunning = true
    setImmediate(() => {
      void this.runControlActionWorker(bot)
    })
  }

  private async runControlActionWorker(bot: MineflayerWithAgents): Promise<void> {
    try {
      while (this.pendingControlActions.length > 0) {
        const entry = this.pendingControlActions.shift()!
        entry.state = 'executing'
        entry.startedAt = Date.now()
        this.activeControlAction = entry
        this.touchActionQueue()

        this.appendLlmLog({
          turnId: entry.sourceTurnId,
          kind: 'scheduler',
          eventType: 'system_alert',
          sourceType: 'system',
          sourceId: 'brain:action_queue',
          tags: ['scheduler', 'action_queue', 'executing'],
          text: `Executing control action #${entry.id}: ${entry.action.tool}`,
          metadata: {
            actionId: entry.id,
          },
        })

        const actionDef = this.deps.taskExecutor.getAvailableActions().find(item => item.name === entry.action.tool)
        if (actionDef?.followControl === 'detach')
          this.deps.reflexManager.clearFollowTarget()

        const cancellationToken = createCancellationToken()
        this.currentCancellationToken = cancellationToken

        try {
          const result = await this.deps.taskExecutor.executeActionWithResult(entry.action, cancellationToken)
          const cancelledByStop = cancellationToken.isCancelled || this.stopCancelledControlActionIds.has(entry.id)
          if (cancelledByStop) {
            entry.state = 'cancelled'
            entry.error = 'Cancelled by stop action'
            entry.finishedAt = Date.now()
            this.pushRecentControlAction(entry)

            this.appendLlmLog({
              turnId: entry.sourceTurnId,
              kind: 'scheduler',
              eventType: 'feedback',
              sourceType: 'system',
              sourceId: 'brain:action_queue',
              tags: ['scheduler', 'action_queue', 'cancelled', entry.action.tool],
              text: `Control action #${entry.id} cancelled: ${entry.action.tool}`,
              metadata: {
                actionId: entry.id,
                reason: 'stop',
              },
            })

            this.stopCancelledControlActionIds.delete(entry.id)
            this.activeControlAction = null
            this.touchActionQueue()
            continue
          }

          entry.state = 'succeeded'
          entry.result = result
          entry.finishedAt = Date.now()
          this.pushRecentControlAction(entry)
          this.completedControlActionsSinceLastFeedback++

          this.appendLlmLog({
            turnId: entry.sourceTurnId,
            kind: 'scheduler',
            eventType: 'feedback',
            sourceType: 'system',
            sourceId: 'brain:action_queue',
            tags: ['scheduler', 'action_queue', 'success', entry.action.tool],
            text: `Control action #${entry.id} succeeded: ${entry.action.tool}`,
          })

          this.activeControlAction = null
          this.touchActionQueue()

          if (this.pendingControlActions.length === 0) {
            const completedCount = this.completedControlActionsSinceLastFeedback
            this.completedControlActionsSinceLastFeedback = 0
            await this.enqueueEvent(bot, {
              type: 'feedback',
              payload: {
                status: 'success',
                action: entry.action,
                result: entry.result,
                summary: {
                  queueDrained: true,
                  completedCount,
                },
              },
              source: { type: 'system', id: 'executor' },
              timestamp: Date.now(),
            })
          }
        }
        catch (err) {
          const interrupted = err instanceof ActionError && err.code === 'INTERRUPTED'
          const cancelledByStop = cancellationToken.isCancelled
            || interrupted
            || this.stopCancelledControlActionIds.has(entry.id)

          if (cancelledByStop) {
            entry.state = 'cancelled'
            entry.error = 'Cancelled by stop action'
            entry.finishedAt = Date.now()
            this.pushRecentControlAction(entry)

            this.appendLlmLog({
              turnId: entry.sourceTurnId,
              kind: 'scheduler',
              eventType: 'feedback',
              sourceType: 'system',
              sourceId: 'brain:action_queue',
              tags: ['scheduler', 'action_queue', 'cancelled', entry.action.tool],
              text: `Control action #${entry.id} cancelled: ${entry.action.tool}`,
              metadata: {
                actionId: entry.id,
                reason: interrupted ? 'interrupted' : 'stop',
              },
            })

            this.stopCancelledControlActionIds.delete(entry.id)
            this.activeControlAction = null
            this.touchActionQueue()
            continue
          }

          const errorMessage = toErrorMessage(err)
          entry.state = 'failed'
          entry.error = errorMessage
          entry.finishedAt = Date.now()
          this.pushRecentControlAction(entry)

          const clearedCount = this.clearPendingControlActions('cancelled')
          this.completedControlActionsSinceLastFeedback = 0
          this.activeControlAction = null
          this.touchActionQueue()

          this.appendLlmLog({
            turnId: entry.sourceTurnId,
            kind: 'scheduler',
            eventType: 'feedback',
            sourceType: 'system',
            sourceId: 'brain:action_queue',
            tags: ['scheduler', 'action_queue', 'failure', entry.action.tool],
            text: `Control action #${entry.id} failed: ${entry.action.tool}`,
            metadata: {
              actionId: entry.id,
              clearedPendingCount: clearedCount,
              error: errorMessage,
            },
          })

          await this.enqueueEvent(bot, {
            type: 'feedback',
            payload: {
              status: 'failure',
              action: entry.action,
              error: errorMessage,
              summary: {
                failedActionId: entry.id,
                clearedPendingCount: clearedCount,
              },
            },
            source: { type: 'system', id: 'executor' },
            timestamp: Date.now(),
          })
          break
        }
        finally {
          if (this.currentCancellationToken === cancellationToken) {
            this.currentCancellationToken = undefined
          }
        }
      }
    }
    finally {
      this.isActionWorkerRunning = false
      if (this.pendingControlActions.length > 0 && this.runtimeMineflayer) {
        this.startControlActionWorker(this.runtimeMineflayer)
      }
    }
  }

  private async executeStopAction(bot: MineflayerWithAgents, sourceTurnId: number): Promise<unknown> {
    const clearedCount = this.clearPendingControlActions('cancelled')
    const cancelledActiveActionId = this.activeControlAction?.id
    if (cancelledActiveActionId)
      this.stopCancelledControlActionIds.add(cancelledActiveActionId)

    this.currentCancellationToken?.cancel()
    this.deps.reflexManager.clearFollowTarget()

    try {
      bot.interrupt('stop requested by brain')
    }
    catch (err) {
      this.deps.logger.withError(err as Error).warn('Brain: Failed to interrupt mineflayer during stop')
    }

    this.completedControlActionsSinceLastFeedback = 0

    this.appendLlmLog({
      turnId: sourceTurnId,
      kind: 'scheduler',
      eventType: 'system_alert',
      sourceType: 'system',
      sourceId: 'brain:action_queue',
      tags: ['scheduler', 'action_queue', 'stop'],
      text: `Stop requested. Cleared pending control actions: ${clearedCount}`,
      metadata: {
        cancelledActiveActionId,
      },
    })

    const result = await this.deps.taskExecutor.executeActionWithResult({ tool: 'stop', params: {} })
    void this.enqueueEvent(bot, {
      type: 'feedback',
      payload: {
        status: 'success',
        action: { tool: 'stop', params: {} },
        result,
        summary: {
          clearedPendingCount: clearedCount,
          cancelledActiveActionId,
        },
      },
      source: { type: 'system', id: 'executor' },
      timestamp: Date.now(),
    }).catch(err => this.deps.logger.withError(err).error('Brain: Failed to enqueue stop feedback'))

    return {
      ok: true,
      stopped: true,
      clearedPendingCount: clearedCount,
      cancelledActiveActionId,
    }
  }

  private queueNoActionFollowup(
    bot: MineflayerWithAgents,
    triggeringEvent: BotEvent,
    turnId: number,
    returnValue: string | undefined,
    logs: string[],
  ): void {
    const signature = this.buildNoActionSignature(returnValue, logs)
    const budgetBefore = this.noActionFollowupBudgetRemaining
    if (signature === this.noActionFollowupLastSignature)
      this.noActionFollowupStagnationCount++
    else
      this.noActionFollowupStagnationCount = 0
    this.noActionFollowupLastSignature = signature

    const stagnated = this.noActionFollowupStagnationCount >= NO_ACTION_STAGNATION_REPEAT_LIMIT
    const exhausted = this.noActionFollowupBudgetRemaining <= 0
    if (stagnated || exhausted) {
      const reason: 'no_action_budget_exhausted' | 'no_action_stagnated' = exhausted
        ? 'no_action_budget_exhausted'
        : 'no_action_stagnated'

      this.appendLlmLog({
        turnId,
        kind: 'scheduler',
        eventType: triggeringEvent.type,
        sourceType: triggeringEvent.source.type,
        sourceId: triggeringEvent.source.id,
        tags: ['scheduler', 'no_action', 'blocked', reason],
        text: `Blocked no-action follow-up: ${reason}`,
        metadata: {
          budgetBefore,
          budgetAfter: this.noActionFollowupBudgetRemaining,
          stagnationCount: this.noActionFollowupStagnationCount,
          signature,
          returnValue: returnValue ?? 'undefined',
        },
      })

      if (triggeringEvent.source.type === 'system' && triggeringEvent.source.id === NO_ACTION_BUDGET_ALERT_SOURCE_ID) {
        this.deps.logger.log('INFO', `Brain: Suppressed repeated no-action budget alert (${reason})`)
        return
      }

      this.debugService.log('DEBUG', `No-action follow-up blocked: ${reason}`)
      this.emitNoActionBudgetDebugChat(bot, reason)

      const followupEvent: BotEvent = {
        type: 'system_alert',
        payload: {
          reason,
          returnValue: returnValue ?? 'undefined',
          logs: logs.slice(-3),
          noActionBudget: this.getNoActionBudgetState(),
          guidance: 'No-action follow-up budget exhausted. Abandon this approach or call setNoActionBudget(n) for this scenario.',
        },
        source: { type: 'system', id: NO_ACTION_BUDGET_ALERT_SOURCE_ID },
        timestamp: Date.now(),
      }

      void this.enqueueEvent(bot, followupEvent).catch(err =>
        this.deps.logger.withError(err).error('Brain: Failed to enqueue no-action budget alert'),
      )
      return
    }

    this.noActionFollowupBudgetRemaining = Math.max(0, this.noActionFollowupBudgetRemaining - 1)
    const budgetAfter = this.noActionFollowupBudgetRemaining

    const followupEvent: BotEvent = {
      type: 'system_alert',
      payload: {
        reason: 'no_actions',
        returnValue: returnValue ?? 'undefined',
        logs: logs.slice(-3),
        noActionBudget: this.getNoActionBudgetState(),
      },
      source: { type: 'system', id: NO_ACTION_FOLLOWUP_SOURCE_ID },
      timestamp: Date.now(),
    }

    this.appendLlmLog({
      turnId,
      kind: 'scheduler',
      eventType: triggeringEvent.type,
      sourceType: triggeringEvent.source.type,
      sourceId: triggeringEvent.source.id,
      tags: ['scheduler', 'no_action'],
      text: 'Scheduled budgeted no-action follow-up turn',
      metadata: {
        returnValue: returnValue ?? 'undefined',
        budgetBefore,
        budgetAfter,
        stagnationCount: this.noActionFollowupStagnationCount,
        signature,
      },
    })
    this.debugService.log('DEBUG', 'Scheduling budgeted no-action follow-up turn')
    void this.enqueueEvent(bot, followupEvent).catch(err =>
      this.deps.logger.withError(err).error('Brain: Failed to enqueue no-action follow-up'),
    )
  }

  /**
   * Gives the model a turn to actually look at the frame it just rendered.
   *
   * `look` returns text ("captured, you will see it next turn") because a sandboxed tool cannot
   * hand back an image. Without a follow-up the picture would sit in the mailbox until some
   * unrelated event happened to trigger the next turn — which, for an idle bot, could be minutes,
   * or long enough that the view is no longer what the bot is looking at.
   */
  private queueVisionFollowup(
    bot: MineflayerWithAgents,
    triggeringEvent: BotEvent,
    turnId: number,
    actions: ActionRuntimeResult[],
  ): void {
    const looked = actions.some(item => item.action.tool === 'look' && item.ok)
    if (!looked || !hasPendingVisionFrame())
      return

    const triggeredByVision = triggeringEvent.source.type === 'system'
      && triggeringEvent.source.id === VISION_FOLLOWUP_SOURCE_ID
    this.visionFollowupStreak = triggeredByVision ? this.visionFollowupStreak + 1 : 1

    if (this.visionFollowupStreak > VISION_FOLLOWUP_STREAK_LIMIT) {
      // Drop the frame with the follow-up: leaving it queued would attach a stale view to whatever
      // unrelated turn comes next.
      takePendingVisionFrame()
      this.visionFollowupStreak = 0

      this.appendLlmLog({
        turnId,
        kind: 'scheduler',
        eventType: triggeringEvent.type,
        sourceType: triggeringEvent.source.type,
        sourceId: triggeringEvent.source.id,
        tags: ['scheduler', 'vision', 'blocked'],
        text: `Blocked vision follow-up after ${VISION_FOLLOWUP_STREAK_LIMIT} consecutive looks`,
      })

      void this.enqueueEvent(bot, {
        type: 'system_alert',
        payload: {
          reason: 'vision_followup_exhausted',
          guidance: `You looked ${VISION_FOLLOWUP_STREAK_LIMIT} turns in a row without acting. The latest picture was discarded. Decide from what you already saw, or use the world state and the map.`,
        },
        source: { type: 'system', id: VISION_FOLLOWUP_SOURCE_ID },
        timestamp: Date.now(),
      }).catch(err =>
        this.deps.logger.withError(err).error('Brain: Failed to enqueue vision follow-up limit alert'),
      )
      return
    }

    this.appendLlmLog({
      turnId,
      kind: 'scheduler',
      eventType: triggeringEvent.type,
      sourceType: triggeringEvent.source.type,
      sourceId: triggeringEvent.source.id,
      tags: ['scheduler', 'vision'],
      text: 'Scheduled vision follow-up turn',
      metadata: { streak: this.visionFollowupStreak },
    })

    void this.enqueueEvent(bot, {
      type: 'system_alert',
      payload: {
        reason: 'vision_frame_ready',
        guidance: 'The view you rendered is attached to this turn. Act on what you can see.',
      },
      source: { type: 'system', id: VISION_FOLLOWUP_SOURCE_ID },
      timestamp: Date.now(),
    }).catch(err =>
      this.deps.logger.withError(err).error('Brain: Failed to enqueue vision follow-up'),
    )
  }

  // --- Event Queue Logic ---

  private async enqueueEvent(bot: MineflayerWithAgents, event: BotEvent): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ event, resolve, reject })
      this.trimEventQueueOverflow()
      // Use setImmediate to avoid re-entrant processQueue calls that could
      // bypass the isProcessing guard during the finally block.
      if (!this.isProcessing) {
        setImmediate(() => this.processQueue(bot))
      }
    })
  }

  /**
   * Coalesce the event queue: promote high-priority events (player chat, AIRI commands)
   * ahead of stale low-priority events (feedback, no-action follow-ups),
   * and drop redundant stale follow-ups when a higher-priority event exists.
   */
  private coalesceQueue(): void {
    if (this.queue.length <= 1)
      return

    const hasHighPriority = this.queue.some(
      item => getEventPriority(item.event) <= EVENT_PRIORITY_PERCEPTION,
    )
    if (!hasHighPriority)
      return

    // Drop redundant no-action follow-ups when an urgent perception is waiting
    const hasUrgentPerception = this.queue.some(
      item => getEventPriority(item.event) === EVENT_PRIORITY_URGENT_PERCEPTION,
    )
    if (hasUrgentPerception) {
      const before = this.queue.length
      const dropped: QueuedEvent[] = []
      this.queue = this.queue.filter((item) => {
        if (getEventPriority(item.event) === EVENT_PRIORITY_NO_ACTION_FOLLOWUP) {
          dropped.push(item)
          return false
        }
        return true
      })
      // Resolve dropped promises so they don't hang
      for (const item of dropped)
        item.resolve()

      if (before !== this.queue.length) {
        this.appendLlmLog({
          turnId: this.turnCounter,
          kind: 'scheduler',
          eventType: 'system_alert',
          sourceType: 'system',
          sourceId: 'brain:coalesce',
          tags: ['scheduler', 'coalesce', 'drop_followups'],
          text: `Coalesced queue: dropped ${before - this.queue.length} stale no-action follow-ups (urgent perception waiting)`,
        })
      }
    }

    // Stable-sort by priority so urgent perception events are processed first
    this.queue.sort((a, b) => getEventPriority(a.event) - getEventPriority(b.event))
  }

  private trimEventQueueOverflow(): void {
    while (this.queue.length > MAX_EVENT_QUEUE_LENGTH) {
      const dropIndex = this.findOverflowDropIndex()
      const [dropped] = this.queue.splice(dropIndex, 1)
      if (!dropped)
        break

      dropped.resolve()
      this.appendLlmLog({
        turnId: this.turnCounter,
        kind: 'scheduler',
        eventType: dropped.event.type,
        sourceType: dropped.event.source.type,
        sourceId: dropped.event.source.id,
        tags: ['scheduler', 'queue', 'overflow_drop'],
        text: `Dropped queued event due to queue overflow (max=${MAX_EVENT_QUEUE_LENGTH})`,
        metadata: {
          droppedPriority: getEventPriority(dropped.event),
          queueLength: this.queue.length,
        },
      })
    }
  }

  private findOverflowDropIndex(): number {
    const nonFeedbackCandidateIndex = this.findOverflowDropIndexByFilter(
      item => item.event.type !== 'feedback',
    )
    if (nonFeedbackCandidateIndex >= 0)
      return nonFeedbackCandidateIndex

    return this.findOverflowDropIndexByFilter(() => true)
  }

  private findOverflowDropIndexByFilter(filter: (item: QueuedEvent) => boolean): number {
    let candidateIndex = -1
    let candidatePriority = Number.NEGATIVE_INFINITY

    for (let index = 0; index < this.queue.length; index++) {
      const item = this.queue[index]!
      if (!filter(item))
        continue

      const priority = getEventPriority(item.event)
      if (candidateIndex === -1 || priority > candidatePriority) {
        candidatePriority = priority
        candidateIndex = index
      }
    }

    return candidateIndex
  }

  private dequeueNextQueuedEvent(): QueuedEvent {
    const shouldForceLowPriorityDispatch = this.consecutiveHighPriorityTurns >= MAX_CONSECUTIVE_HIGH_PRIORITY_TURNS
    let item: QueuedEvent | undefined

    if (shouldForceLowPriorityDispatch) {
      const lowPriorityIndex = this.queue.findIndex(
        candidate => getEventPriority(candidate.event) > EVENT_PRIORITY_PERCEPTION,
      )
      if (lowPriorityIndex >= 0) {
        // FIXME: Temporary starvation guard. Replace with weighted-fair scheduling once queue model is refactored.
        item = this.queue.splice(lowPriorityIndex, 1)[0]
        this.appendLlmLog({
          turnId: this.turnCounter,
          kind: 'scheduler',
          eventType: item.event.type,
          sourceType: item.event.source.type,
          sourceId: 'brain:starvation_guard',
          tags: ['scheduler', 'queue', 'starvation_guard', 'temp_fix'],
          text: 'Forced a low-priority event after high-priority streak',
          metadata: {
            streakBeforeDispatch: this.consecutiveHighPriorityTurns,
            queueLength: this.queue.length,
          },
        })
      }
    }

    if (!item)
      item = this.queue.shift()!

    if (getEventPriority(item.event) <= EVENT_PRIORITY_PERCEPTION)
      this.consecutiveHighPriorityTurns += 1
    else
      this.consecutiveHighPriorityTurns = 0

    return item
  }

  private async processQueue(bot: MineflayerWithAgents): Promise<void> {
    if (this.isProcessing || this.queue.length === 0)
      return

    try {
      this.isProcessing = true
      this.debugService.emitBrainState({
        status: 'processing',
        queueLength: this.queue.length,
        lastContextView: this.lastContextView,
      })

      this.coalesceQueue()
      const item = this.dequeueNextQueuedEvent()

      try {
        await this.processEvent(bot, item.event)
        item.resolve()
      }
      catch (err) {
        this.deps.logger.withError(err).error('Brain: Error processing event')
        item.reject(err as Error)
      }
    }
    finally {
      this.isProcessing = false
      this.debugService.emitBrainState({
        status: 'idle',
        queueLength: this.queue.length,
        lastContextView: this.lastContextView,
      })

      if (this.queue.length === 0)
        this.consecutiveHighPriorityTurns = 0

      if (this.queue.length > 0) {
        setImmediate(() => this.processQueue(bot))
      }
    }
  }

  // --- Cognitive Cycle ---

  private async processEvent(bot: MineflayerWithAgents, event: BotEvent): Promise<void> {
    if (this.paused) {
      this.appendLlmLog({
        turnId: this.turnCounter,
        kind: 'scheduler',
        eventType: event.type,
        sourceType: event.source.type,
        sourceId: event.source.id,
        tags: ['scheduler', 'paused', 'suppressed'],
        text: `Suppressed event while paused: ${event.type} from ${event.source.type}:${event.source.id}`,
      })
      this.deps.logger.log('INFO', `Brain: Ignoring event while paused (${event.type} from ${event.source.type}:${event.source.id})`)
      return
    }

    this.resumeFromGiveUpIfNeeded(event)
    if (this.shouldSuppressDuringGiveUp(event))
      return
    if (this.isPlayerChatEvent(event))
      this.resetNoActionFollowupBudget('player_chat')
    if (this.isAiriCommandEvent(event))
      this.resetNoActionFollowupBudget('airi_command')

    const turnId = ++this.turnCounter
    this.maybeActivateErrorBurstGuard(bot, event, turnId)

    // 0. Build Context View
    const snapshot = this.deps.reflexManager.getContextSnapshot()
    const view = buildConsciousContextView(snapshot)
    const contextView = `[PERCEPTION] Self: ${view.selfSummary}\nEnvironment: ${view.environmentSummary}`

    // 1. Construct User Message (Diffing happens here)
    const userMessage = this.buildUserMessage(event, contextView)

    // Update state after consuming difference
    this.lastContextView = contextView

    // 2. Prepare System Prompt (static + bound master identity)
    const systemPrompt = generateBrainSystemPrompt(this.deps.taskExecutor.getAvailableActions(), {
      masterUsername: config.bot.masterUsername,
      startupSummary: this.startupSummary,
    })
    this.currentInputEnvelope = {
      id: turnId,
      turnId,
      timestamp: Date.now(),
      event: {
        type: event.type,
        sourceType: event.source.type,
        sourceId: event.source.id,
        payload: event.payload,
      },
      contextView,
      userMessage,
      systemPrompt: {
        preview: truncateForPrompt(systemPrompt, 240),
        length: systemPrompt.length,
      },
    }
    this.appendLlmLog({
      turnId,
      kind: 'turn_input',
      eventType: event.type,
      sourceType: event.source.type,
      sourceId: event.source.id,
      tags: ['input', event.type],
      text: truncateForPrompt(userMessage, 600),
      metadata: {
        queueLength: this.queue.length,
      },
    })

    this.debugService.emitConversationUpdate({
      messages: this.toDebugConversationMessages(this.cloneMessages([
        ...this.conversationHistory,
        { role: 'user', content: userMessage },
      ])),
      isProcessing: true,
    })

    // A frame the bot rendered for itself on an earlier turn. Drained once, before the retry loop,
    // so a retried request still carries the picture the model asked for.
    const visionFrame = takePendingVisionFrame()

    // 3. Call LLM with retry logic
    const maxAttempts = 3
    let result: string | null = null
    let lastError: unknown
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Check pause at start of each retry attempt
      if (this.paused) {
        this.appendLlmLog({
          turnId,
          kind: 'scheduler',
          eventType: event.type,
          sourceType: event.source.type,
          sourceId: event.source.id,
          tags: ['scheduler', 'paused', 'interrupted'],
          text: `Interrupted during LLM retry loop (attempt ${attempt}/${maxAttempts}) while paused`,
        })
        this.deps.logger.log('INFO', `Brain: Interrupted LLM retry loop while paused (attempt ${attempt}/${maxAttempts})`)
        return
      }

      try {
        // Build messages: system + conversation history + new user message
        const messages: Message[] = [
          { role: 'system', content: systemPrompt },
          ...this.conversationHistory,
          buildUserTurnMessage(userMessage, visionFrame),
        ]
        this.lastLlmInputSnapshot = {
          systemPrompt,
          userMessage,
          messages: this.cloneMessages(messages),
          conversationHistory: this.cloneMessages(this.conversationHistory),
          updatedAt: Date.now(),
          attempt,
        }
        this.currentInputEnvelope.llm = {
          attempt,
          model: config.openai.model,
        }
        this.appendLlmLog({
          turnId,
          kind: 'llm_attempt',
          eventType: event.type,
          sourceType: event.source.type,
          sourceId: event.source.id,
          tags: ['llm', 'attempt'],
          text: `LLM attempt ${attempt}/${maxAttempts}`,
          metadata: {
            attempt,
            maxAttempts,
            messageCount: messages.length,
          },
        })

        const traceStart = Date.now()

        const llmResult = await this.callLLM(messages)

        const content = llmResult.text
        const reasoning = llmResult.reasoning

        if (!content)
          throw new Error('No content from LLM')

        // NOTICE: `reasoning` is consumed here (LLM log + debug trace) and then dropped. It is
        // deliberately not carried into `conversationHistory` — see the note where the assistant
        // message is appended.
        result = content

        this.debugService.traceLLM({
          route: 'brain',
          messages,
          content,
          reasoning,
          usage: llmResult.usage,
          model: config.openai.model,
          duration: Date.now() - traceStart,
        })
        // Store lightweight trace (no full messages clone to prevent O(turns²) memory)
        const estimatedTokens = Math.ceil(messages.reduce((sum, m) => {
          const c = typeof m.content === 'string' ? m.content.length : 0
          return sum + c
        }, 0) / 4)
        this.llmTraceEntries.push({
          id: ++this.llmTraceIdCounter,
          turnId,
          timestamp: Date.now(),
          eventType: event.type,
          sourceType: event.source.type,
          sourceId: event.source.id,
          attempt,
          model: config.openai.model,
          messageCount: messages.length,
          estimatedTokens,
          content,
          reasoning,
          usage: llmResult.usage,
          durationMs: Date.now() - traceStart,
        })
        if (this.llmTraceEntries.length > 500) {
          this.llmTraceEntries.shift()
        }
        this.currentInputEnvelope.llm = {
          attempt,
          model: config.openai.model,
          usage: llmResult.usage,
        }
        this.appendLlmLog({
          turnId,
          kind: 'llm_attempt',
          eventType: event.type,
          sourceType: event.source.type,
          sourceId: event.source.id,
          tags: ['llm', 'response'],
          text: truncateForPrompt(content, 400),
          metadata: {
            attempt,
            usage: llmResult.usage,
            reasoningSize: reasoning?.length ?? 0,
          },
        })

        this.debugService.emitBrainState({
          status: 'processing',
          queueLength: this.queue.length,
          lastContextView: this.lastContextView,
        })

        break // Success, exit retry loop
      }
      catch (err) {
        if (this.paused && this.isAbortError(err)) {
          this.appendLlmLog({
            turnId,
            kind: 'scheduler',
            eventType: event.type,
            sourceType: event.source.type,
            sourceId: event.source.id,
            tags: ['scheduler', 'paused', 'interrupted'],
            text: `Interrupted during LLM call (attempt ${attempt}/${maxAttempts}) while paused`,
            metadata: {
              attempt,
              maxAttempts,
            },
          })
          this.deps.logger.log('INFO', `Brain: Interrupted LLM call while paused (attempt ${attempt}/${maxAttempts})`)
          return
        }

        lastError = err
        const remaining = maxAttempts - attempt
        const isRateLimit = isRateLimitError(err)
        const isAuthOrBadArg = isLikelyAuthOrBadArgError(err)
        const { shouldRetry } = shouldRetryError(err, remaining)
        this.deps.logger.withError(err).error(`Brain: Decision attempt failed (attempt ${attempt}/${maxAttempts}, retry: ${shouldRetry}, rateLimit: ${isRateLimit})`)

        if (!shouldRetry) {
          if (isAuthOrBadArg)
            throw err

          this.deps.logger.withError(err).warn('Brain: Decision attempts exhausted, skipping turn')
          break
        }

        const backoffMs = isRateLimit
          ? Math.min(5000, 1000 * attempt) + Math.floor(Math.random() * 200)
          : 150
        await sleep(backoffMs)

        // Check pause after backoff sleep (before next retry)
        if (this.paused) {
          this.appendLlmLog({
            turnId,
            kind: 'scheduler',
            eventType: event.type,
            sourceType: event.source.type,
            sourceId: event.source.id,
            tags: ['scheduler', 'paused', 'interrupted'],
            text: `Interrupted after retry backoff (attempt ${attempt}/${maxAttempts}) while paused`,
          })
          this.deps.logger.log('INFO', `Brain: Interrupted after retry backoff while paused (attempt ${attempt}/${maxAttempts})`)
          return
        }
      }
    }

    // 4. Parse & Execute
    if (!result) {
      this.deps.logger.withError(lastError).warn('Brain: No response after all retries')
      this.appendLlmLog({
        turnId,
        kind: 'repl_error',
        eventType: event.type,
        sourceType: event.source.type,
        sourceId: event.source.id,
        tags: ['repl', 'error', 'empty_response'],
        text: 'No LLM response after retries',
      })
      this.maybeActivateErrorBurstGuard(bot, event, turnId)
      return
    }

    // Check pause again after LLM call (allows !pause to interrupt before REPL execution)
    if (this.paused) {
      this.appendLlmLog({
        turnId,
        kind: 'scheduler',
        eventType: event.type,
        sourceType: event.source.type,
        sourceId: event.source.id,
        tags: ['scheduler', 'paused', 'interrupted'],
        text: `Interrupted before REPL execution while paused: ${event.type} from ${event.source.type}:${event.source.id}`,
      })
      this.deps.logger.log('INFO', `Brain: Interrupted processing before REPL while paused (${event.type} from ${event.source.type}:${event.source.id})`)
      return
    }

    try {
      // Only append to conversation history after successful parsing (avoid dirty data on retry).
      // Deliberately the plain text, never the image parts built by `buildUserTurnMessage`: a
      // rendered frame is worth its tokens on the turn that asked for it and nowhere else.
      this.conversationHistory.push({ role: 'user', content: userMessage })
      // NOTICE: `reasoning` is deliberately NOT stored.
      //
      // It used to be kept on the assistant message and sent back verbatim on every subsequent
      // turn, since xsai forwards `messages` into the request body untouched. That is wasted
      // context — the model's own scratch thinking, re-billed each turn and growing without bound —
      // and DeepSeek's API documentation explicitly says not to echo `reasoning_content` back.
      // It is still recorded for the current turn in the LLM log and the debug trace.
      this.conversationHistory.push({
        role: 'assistant',
        content: result,
      } as Message)

      // Trim conversation history as an in-memory safety net for long sessions. Batched on purpose;
      // see CONVERSATION_HISTORY_TRIM_BATCH.
      this.conversationHistory = trimConversationHistory(this.conversationHistory)

      // Checkpoint the session memory periodically. `destroy()` also saves, but a bot process is
      // just as likely to be killed as shut down cleanly, and losing the whole session's context to
      // a SIGKILL defeats the point of persisting it.
      if (turnId % SESSION_MEMORY_CHECKPOINT_TURNS === 0)
        this.persistSessionMemory()

      const actionDefs = new Map(this.deps.taskExecutor.getAvailableActions().map(action => [action.name, action]))

      const normalizedLlmCode = this.normalizeReplCode(result)
      const codeToEvaluate = this.repl.canEvaluateAsExpression(normalizedLlmCode)
        ? `return (\n${normalizedLlmCode}\n)`
        : normalizedLlmCode

      const runResult = await this.repl.evaluate(
        codeToEvaluate,
        this.deps.taskExecutor.getAvailableActions(),
        this.createRuntimeGlobals(event, snapshot as unknown as Record<string, unknown>, bot),
        async (action: ActionInstruction) => {
          const actionDef = actionDefs.get(action.tool)
          if (action.tool === 'stop') {
            return this.executeStopAction(bot, turnId)
          }

          const isControlAction = this.isQueueConsumingControlAction(action, actionDef)
          if (isControlAction)
            return this.enqueueControlAction(bot, action, turnId)

          if (actionDef?.followControl === 'detach')
            this.deps.reflexManager.clearFollowTarget()

          return this.deps.taskExecutor.executeActionWithResult(action)
        },
      )

      this.lastReplOutcome = {
        actionCount: runResult.actions.length,
        okCount: runResult.actions.filter(item => item.ok).length,
        errorCount: runResult.actions.filter(item => !item.ok).length,
        returnValue: runResult.returnValue,
        logs: runResult.logs.slice(-3),
        updatedAt: Date.now(),
      }
      this.appendLlmLog({
        turnId,
        kind: 'repl_result',
        eventType: event.type,
        sourceType: event.source.type,
        sourceId: event.source.id,
        tags: [
          'repl',
          runResult.actions.length === 0 ? 'no_actions' : 'actions',
          runResult.actions.some(item => !item.ok) ? 'error' : 'ok',
        ],
        text: `actions=${runResult.actions.length} return=${runResult.returnValue ?? 'undefined'}`,
        metadata: {
          returnValue: runResult.returnValue,
          actionCount: runResult.actions.length,
          okCount: runResult.actions.filter(item => item.ok).length,
          errorCount: runResult.actions.filter(item => !item.ok).length,
          actions: runResult.actions.map(item => ({
            tool: item.action.tool,
            ok: item.ok,
            error: item.error,
          })),
          logs: runResult.logs.slice(-5),
        },
      })
      this.updateErrorBurstGuardCompletion(
        turnId,
        runResult.actions.map(item => ({
          action: item.action,
          ok: item.ok,
        })),
      )
      this.maybeActivateErrorBurstGuard(bot, event, turnId)
      this.queueVisionFollowup(bot, event, turnId, runResult.actions)

      if (runResult.actions.length === 0 || runResult.actions.every(item => item.action.tool === 'skip')) {
        this.debugService.emit('debug:repl_result', {
          source: 'llm',
          code: result,
          logs: runResult.logs,
          actions: this.toDebugReplActions(runResult.actions),
          returnValue: runResult.returnValue,
          durationMs: 0,
          timestamp: Date.now(),
        })
        if (runResult.actions.length === 0) {
          this.queueNoActionFollowup(bot, event, turnId, runResult.returnValue, runResult.logs)
        }
        this.deps.logger.log('INFO', 'Brain: Skipping turn (observing)')
        this.emitConversationUpdate(false)
        return
      }

      this.debugService.emit('debug:repl_result', {
        source: 'llm',
        code: result,
        logs: runResult.logs,
        actions: this.toDebugReplActions(runResult.actions),
        returnValue: runResult.returnValue,
        durationMs: 0,
        timestamp: Date.now(),
      })

      this.deps.logger.log('INFO', `Brain: Executed ${runResult.actions.length} action(s)`, {
        actions: runResult.actions.map(item => ({
          tool: item.action.tool,
          ok: item.ok,
          result: item.result,
          error: item.error,
        })),
        logs: runResult.logs,
        returnValue: runResult.returnValue,
      })
      this.emitConversationUpdate(false)
    }
    catch (err) {
      this.deps.logger.withError(err).error('Brain: Failed to execute decision')
      this.appendLlmLog({
        turnId,
        kind: 'repl_error',
        eventType: event.type,
        sourceType: event.source.type,
        sourceId: event.source.id,
        tags: ['repl', 'error'],
        text: truncateForPrompt(toErrorMessage(err), 360),
        metadata: {
          code: result,
        },
      })
      this.maybeActivateErrorBurstGuard(bot, event, turnId)
      const augmentedError = augmentDecisionError(toErrorMessage(err))
      this.debugService.emit('debug:repl_result', {
        source: 'llm',
        code: result,
        logs: [],
        actions: [],
        error: augmentedError,
        durationMs: 0,
        timestamp: Date.now(),
      })
      void this.enqueueEvent(bot, {
        type: 'feedback',
        payload: { status: 'failure', error: augmentedError },
        source: { type: 'system', id: 'brain' },
        timestamp: Date.now(),
      })
      this.emitConversationUpdate(false)
    }
  }

  private buildUserMessage(event: BotEvent, contextView: string): string {
    const parts: string[] = []

    // 1. Event Content
    if (event.type === 'perception') {
      const signal = event.payload as PerceptionSignal
      if (signal.type === 'chat_message') {
        parts.push(`[EVENT] ${signal.description}`)
      }
      else {
        parts.push(`[EVENT] Perception Signal: ${signal.description}`)
      }
    }
    else if (event.type === 'feedback') {
      const p = event.payload as any
      const tool = p.action?.tool || 'unknown'
      if (p.status === 'success') {
        const resultText = typeof p.result === 'string' ? p.result : JSON.stringify(p.result)
        parts.push(`[FEEDBACK] ${tool}: Success. ${truncateForPrompt(resultText, 200)}`)
      }
      else {
        parts.push(`[FEEDBACK] ${tool}: Failed. ${p.error}`)
      }
    }
    else {
      parts.push(`[EVENT] ${event.type}: ${JSON.stringify(event.payload)}`)
    }

    // 2. Perception Snapshot Diff
    // Compare with last
    if (contextView !== this.lastContextView) {
      parts.push(contextView)
      // Note: We don't update this.lastContextView here; caller does it after building message
    }

    if (this.givenUp) {
      parts.push(`[STATE] giveUp active (halted until player input). reason=${this.giveUpReason ?? 'unknown'}`)
    }

    if (this.errorBurstGuardState) {
      const guard = this.errorBurstGuardState
      parts.push(`[ERROR_BURST_GUARD] active. errors=${guard.errorTurnCount}/${guard.windowTurns}; threshold=${guard.threshold}`)
      if (guard.recentErrorSummary.length > 0) {
        const condensed = guard.recentErrorSummary
          .slice(0, 3)
          .map(summary => truncateForPrompt(summary, 180))
          .join(' || ')
        parts.push(`[ERROR_BURST_GUARD] recent=${condensed}`)
      }
      parts.push(`[MANDATORY] Too many recent errors. This turn must include BOTH: await giveUp({ reason: "..." }) and await chat({ message: "...", feedback: false }). Explain what failed and what you will do next.`)
    }

    if (this.lastReplOutcome) {
      const ageMs = Date.now() - this.lastReplOutcome.updatedAt
      const returnValue = truncateForPrompt(this.lastReplOutcome.returnValue ?? 'undefined')
      const logs = this.lastReplOutcome.logs.length > 0
        ? this.lastReplOutcome.logs.map((line, index) => `#${index + 1} ${truncateForPrompt(line, 120)}`).join(' | ')
        : '(none)'
      parts.push(`[SCRIPT] Last eval ${ageMs}ms ago: return=${returnValue}; actions=${this.lastReplOutcome.actionCount} (ok=${this.lastReplOutcome.okCount}, err=${this.lastReplOutcome.errorCount}); logs=${logs}`)
    }

    const queueSnapshot = this.getActionQueueSnapshot()
    const runningLabel = queueSnapshot.executing
      ? `${queueSnapshot.executing.tool}#${queueSnapshot.executing.id}`
      : 'none'
    parts.push(`[ACTION_QUEUE] executing=${runningLabel}; pending=${queueSnapshot.counts.pending}; total=${queueSnapshot.counts.total}/${queueSnapshot.capacity.total}`)
    const noActionBudget = this.getNoActionBudgetState()
    parts.push(`[NO_ACTION_BUDGET] remaining=${noActionBudget.remaining}; default=${noActionBudget.default}; max=${noActionBudget.max}; stagnation=${this.noActionFollowupStagnationCount}/${NO_ACTION_STAGNATION_REPEAT_LIMIT}`)
    // Only include [ERROR_BURST] line when the guard is actually active
    // (inactive state is the default and doesn't need to be stated every turn)
    if (this.errorBurstGuardState) {
      parts.push(`[ERROR_BURST] active=yes`)
    }

    return parts.join('\n\n')
  }

  private shouldSuppressDuringGiveUp(event: BotEvent): boolean {
    if (!this.givenUp)
      return false

    if (event.source.type === 'system' && event.source.id === ERROR_BURST_GUARD_SOURCE_ID)
      return false

    if (event.type !== 'perception')
      return true

    const signal = event.payload as PerceptionSignal
    return !this.canResumeFromGiveUp(signal)
  }

  private resumeFromGiveUpIfNeeded(event: BotEvent): void {
    if (!this.givenUp)
      return

    if (event.type !== 'perception')
      return

    const signal = event.payload as PerceptionSignal
    if (!this.canResumeFromGiveUp(signal))
      return

    this.givenUp = false
    this.giveUpReason = undefined
  }

  private canResumeFromGiveUp(signal: PerceptionSignal): boolean {
    return signal.type === 'chat_message' || signal.type === 'airi_command'
  }
}
