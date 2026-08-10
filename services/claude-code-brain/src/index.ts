/**
 * claude-code-brain — serves the user's Claude subscription (via the Claude
 * Agent SDK, i.e. Claude Code's harness) as a local OpenAI-compatible chat
 * endpoint, so AIRI's openai-compatible provider can use Claude as her brain
 * without metered API billing.
 *
 * Call stack:
 *
 * main (this file)
 *   -> http.createServer
 *     -> handleChatCompletions
 *       -> {@link composeQueryInput} (../translate)  — history + images → blocks
 *       -> {@link jsonSchemaToZodShape} (../translate) — AIRI tools → SDK MCP tools
 *       -> query() (@anthropic-ai/claude-agent-sdk, subscription auth)
 *         -> text deltas → SSE via {@link chunkOf} / {@link finalChunkOf}
 *         -> captured tool calls → {@link toolCallChunkOf} (AIRI executes them)
 *     -> handleModels -> {@link ADVERTISED_MODELS}
 *
 * Tool passthrough model: AIRI's tools are registered as in-process MCP tools
 * whose handlers never execute anything — the first call captures the
 * arguments, aborts the query, and the call is returned to AIRI in OpenAI
 * `tool_calls` format. AIRI executes the tool (screenshots, mouse moves, web
 * search...) and calls back with the results in history; the next request
 * replays them (screenshots as real image blocks) and Claude continues.
 *
 * Auth: inherited from the machine's Claude Code login (`claude setup-token` /
 * CLAUDE_CODE_OAUTH_TOKEN also work). Binds 127.0.0.1 only — this proxies a
 * paid subscription and must never be exposed to the LAN.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

import type { SendStrategy } from './sessions'
import type { CapturedToolCall, OpenAIChatRequest, PromptBlock } from './translate'

import http from 'node:http'
import process from 'node:process'

import { Buffer } from 'node:buffer'

import { createSdkMcpServer, deleteSession, listSessions, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { Format, LogLevel, useLogg } from '@guiiai/logg'

import { confirmStartDespiteEgress, decideEgress, parseAllowedEgressIps, probeEgressIp } from './egress-guard'
import { decideStrategy, SessionRegistry, sessionStoreKey } from './sessions'
import { estimateQueryTokens } from './token-estimate'
import { ADVERTISED_MODELS, chunkOf, completionOf, composeCurrentRound, composeQueryInput, composeSystemPrompt, finalChunkOf, jsonSchemaToZodShape, reasoningChunkOf, resolveModelOption, toolCallChunkOf } from './translate'

const log = useLogg('ClaudeCodeBrain').withLogLevel(LogLevel.Log).withFormat(Format.Pretty)

const PORT = Number(process.env.CLAUDE_BRAIN_PORT || 14515)

/**
 * Exit-IP interlock. This bridge spends the user's Claude *subscription*, so
 * which address it appears to come from is theirs to pin: `CLAUDE_BRAIN_EGRESS_IPS`
 * holds the allowed addresses (keep it in `.env`, which is gitignored — an exit
 * IP is not something to commit), and a mismatch or a failed probe stops the
 * start until someone confirms by hand. Set `CLAUDE_BRAIN_EGRESS_CHECK=0` to
 * skip the check entirely.
 */
const EGRESS_CHECK_ENABLED = !['0', 'false'].includes((process.env.CLAUDE_BRAIN_EGRESS_CHECK ?? '').trim().toLowerCase())

/** How long the manual override waits for an answer before declining. */
const EGRESS_CONFIRM_TIMEOUT_MS = 120_000

/**
 * Whether the exit-IP check has cleared. Requests are refused until it has —
 * the listener is bound first so a duplicate instance can bow out quietly.
 */
let egressGateCleared = false

/**
 * Chat companion latency beats reasoning depth here; 'low' keeps replies
 * snappy. Raise via env when Airi should think harder.
 */
const EFFORT = (process.env.CLAUDE_BRAIN_EFFORT || 'low') as 'low' | 'medium' | 'high'

/**
 * Opt-in: forward thinking deltas to AIRI as OpenAI `reasoning_content` so the
 * stage shows Claude's reasoning like it does for DeepSeek R1. Off by default
 * — raw thinking speaks about "Airi" in the third person and may reference
 * system-prompt internals (persona-break risk). Thinking is adaptive: casual
 * chatter gets none, hard questions get a summarized trace (works at any
 * CLAUDE_BRAIN_EFFORT, verified at 'low').
 */
const FORWARD_THINKING = ['1', 'true'].includes(process.env.CLAUDE_BRAIN_FORWARD_THINKING ?? '')

/**
 * Optional cap on replayed conversation rounds. By default the full history is
 * replayed so the persona keeps her whole memory of the relationship — the
 * transcript (and per-request token bill) then grows with the conversation.
 * Set `CLAUDE_BRAIN_MAX_HISTORY` to a positive integer to opt into a cap and
 * curb that growth on very long chats; unset/0/negative means unlimited.
 */
const historyRoundsRaw = Number(process.env.CLAUDE_BRAIN_MAX_HISTORY)
const MAX_HISTORY_ROUNDS = Number.isInteger(historyRoundsRaw) && historyRoundsRaw > 0 ? historyRoundsRaw : undefined

/**
 * Prompt-cache reuse (plan: sequential-leaping-wombat). Keep an SDK session per
 * conversation and resume it — sending only the new turn — instead of
 * re-flattening full history each request, so the stable prefix is cache-read
 * (0.1x) not cache-created (1.25x). On by default (measured ~10x cheaper on the
 * growing context); set `CLAUDE_BRAIN_SESSIONS=0` to fall back to the stateless
 * flatten path. Only pure text turns take the session path; tool turns flatten
 * and invalidate the session.
 */
const SESSIONS_ENABLED = !['0', 'false'].includes(process.env.CLAUDE_BRAIN_SESSIONS ?? '')

/**
 * Best-effort disk cleanup when a session is evicted from the registry. The SDK
 * stores a `.jsonl` transcript per session under `~/.claude/projects/`; without
 * this, files accumulate indefinitely.
 */
function cleanupSessionFile(sessionId: string): void {
  deleteSession(sessionId).catch(() => {})
}

// Process-lifetime conversation→session map. In-memory only: a miss just costs
// one uncached turn, so it need not survive restarts. Evicted/expired entries
// trigger disk cleanup via cleanupSessionFile.
const sessionRegistry = new SessionRegistry(200, 20 * 60 * 1000, cleanupSessionFile)

/**
 * Grace window between the first captured tool call and aborting the query:
 * parallel tool_use blocks in the same assistant message invoke their MCP
 * handlers one after another, and all of them should reach AIRI in one round.
 */
const PARALLEL_CAPTURE_WINDOW_MS = 200

function writeCors(res: ServerResponse): void {
  // The stage renderer (browser / Electron) calls this endpoint cross-origin.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function respondJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

function respondError(res: ServerResponse, status: number, message: string): void {
  respondJson(res, status, JSON.stringify({ error: { message, type: 'invalid_request_error' } }))
}

/**
 * Live model list from the subscription, resolved once and cached for the
 * process lifetime. `supportedModels()` is a control request that needs a
 * streaming-input query, so a throwaway query is spawned just to ask — hence
 * the cache: one subprocess spawn per service start, not per settings-page load.
 */
let cachedModelIds: string[] | undefined

async function fetchSupportedModels(): Promise<string[]> {
  if (cachedModelIds)
    return cachedModelIds

  const abortController = new AbortController()
  // Keeps the input stream open (without sending a turn) until we abort;
  // control requests only work while the stream is live. Never yielding is
  // the point: no user message means no model turn, so the probe is free.
  // oxlint-disable-next-line require-yield
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => {
      abortController.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  const probe = query({
    prompt: idle(),
    options: { abortController, tools: [], settingSources: [], maxTurns: 1 },
  })

  try {
    const models = await Promise.race([
      probe.supportedModels(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('supportedModels timed out')), 15_000)),
    ])
    const liveIds = models.map(model => model.value).filter(id => !!id)
    // Live rows are the subscription's picker aliases (sonnet/opus/haiku/...);
    // explicit pinned IDs like claude-sonnet-4-6 also work (verified: the
    // result's modelUsage bills under the explicit id), so merge the static
    // list in — pickers should offer both.
    cachedModelIds = [...new Set(['default', ...liveIds, ...ADVERTISED_MODELS])]
    log.withFields({ count: cachedModelIds.length }).log('Fetched live model list from subscription')
  }
  catch (error) {
    // Static fallback keeps the settings page usable; not cached so a later
    // load retries the probe.
    log.withError(error as Error).warn('Falling back to static model list')
    return ADVERTISED_MODELS
  }
  finally {
    abortController.abort()
  }
  return cachedModelIds
}

async function handleModels(res: ServerResponse): Promise<void> {
  const ids = await fetchSupportedModels()
  respondJson(res, 200, JSON.stringify({
    object: 'list',
    data: ids.map(id => ({ id, object: 'model', owned_by: 'claude-code-brain' })),
  }))
}

/** The SDK accepts multimodal input only via streaming-input user messages. */
async function* promptStreamOf(blocks: PromptBlock[]): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: blocks },
    parent_tool_use_id: null,
  }
}

/**
 * Shared query options that stay the same between a resume attempt and its
 * fresh retry: model, effort, thinking, tool isolation, SDK isolation.
 */
function baseQueryOptions(model: string, streaming: boolean) {
  return {
    model: resolveModelOption(model),
    effort: EFFORT,
    // NOTICE:
    // `display: 'summarized'` is load-bearing, not cosmetic. In SDK mode
    // (CLAUDE_CODE_ENTRYPOINT=sdk-ts) the CLI suppresses thinking deltas
    // from the stream unless `--thinking-display summarized` is passed —
    // thinking happens, but no thinking_delta stream events arrive
    // (verified on sdk 0.3.214: identical CLI invocations outside the SDK
    // always emitted deltas; through query() they arrived only with
    // display set). Adaptive keeps casual chatter snappy: the model skips
    // thinking on small talk and thinks on hard questions (both verified).
    ...(FORWARD_THINKING ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } } : {}),
    tools: [] as never[],
    settingSources: [] as never[],
    includePartialMessages: streaming,
  }
}

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let request: OpenAIChatRequest
  try {
    request = JSON.parse(await readBody(req)) as OpenAIChatRequest
  }
  catch {
    respondError(res, 400, 'Request body is not valid JSON')
    return
  }

  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    respondError(res, 400, '`messages` must be a non-empty array')
    return
  }

  const model = request.model || 'default'
  const completionId = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const streaming = request.stream !== false
  const requestTools = request.tools ?? []

  // Resume a cached session (send only the new turn) when we hold one for this
  // conversation; otherwise flatten the full history. The persona system prompt
  // is re-sent on both paths so a resumed session never drifts from the card
  // AIRI currently has loaded.
  let strategy: SendStrategy = SESSIONS_ENABLED ? decideStrategy(request.messages, sessionRegistry) : { mode: 'fresh' as const }

  let systemPrompt: string
  let blocks: PromptBlock[]
  if (strategy.mode === 'resume') {
    systemPrompt = composeSystemPrompt(request.messages)
    blocks = composeCurrentRound(request.messages)
  }
  else {
    const composed = composeQueryInput(request.messages, { maxHistoryRounds: MAX_HISTORY_ROUNDS })
    systemPrompt = composed.systemPrompt
    blocks = composed.blocks
  }
  if (blocks.length === 0) {
    respondError(res, 400, 'No usable content found in `messages`')
    return
  }

  // Per-request budget visibility: a single line showing where the (estimated)
  // input tokens go, so a runaway component — usually the replayed transcript —
  // is obvious in the logs. Estimate only; the real bill comes back in `usage`.
  const tokens = estimateQueryTokens({ systemPrompt, blocks, tools: requestTools })
  log.withFields({
    model,
    mode: strategy.mode,
    system: tokens.systemPromptTokens,
    transcript: tokens.transcriptTokens,
    images: `${tokens.imageTokens} (${tokens.imageCount})`,
    tools: `${tokens.toolTokens} (${requestTools.length})`,
    toolNames: requestTools.map(definition => definition.function.name).join(','),
    total: tokens.totalTokens,
  }).log('query input token estimate (~chars/3.5)')

  // Client hang-ups (AIRI cancelling a generation) must kill the underlying
  // Claude Code turn too, or abandoned turns keep burning subscription quota.
  let abortController = new AbortController()
  const onClose = () => {
    if (!res.writableEnded)
      abortController.abort()
  }
  res.on('close', onClose)

  // Tool passthrough: register AIRI's tools as capture-only MCP tools. The
  // handler records the call and schedules an abort instead of executing —
  // execution belongs to AIRI's side of the wire (xdotool, screenshots, ...).
  let capturedCalls: CapturedToolCall[] = []
  let captureAbortTimer: NodeJS.Timeout | undefined

  function buildMcpServers() {
    if (requestTools.length === 0)
      return undefined
    return {
      airi: createSdkMcpServer({
        name: 'airi',
        tools: requestTools.map(definition => tool(
          definition.function.name,
          definition.function.description ?? '',
          jsonSchemaToZodShape(definition.function.parameters),
          async (args) => {
            capturedCalls.push({
              id: `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
              name: definition.function.name,
              arguments: JSON.stringify(args ?? {}),
            })
            captureAbortTimer ??= setTimeout(() => abortController.abort(), PARALLEL_CAPTURE_WINDOW_MS)
            return { content: [{ type: 'text', text: 'Forwarded to the client for execution.' }] }
          },
        )),
      }),
    }
  }

  let generation = query({
    prompt: promptStreamOf(blocks),
    options: {
      abortController,
      systemPrompt,
      ...(strategy.mode === 'resume' ? { resume: strategy.sessionId } : {}),
      ...baseQueryOptions(model, streaming),
      maxTurns: requestTools.length > 0 ? 2 : 1,
      mcpServers: buildMcpServers(),
      allowedTools: requestTools.map(definition => `mcp__airi__${definition.function.name}`),
    },
  })

  if (streaming) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
  }

  let fullText = ''
  let streamedAnyDelta = false
  let capturedSessionId: string | undefined

  const respondCapturedToolCalls = () => {
    // Store the session so the tool-result continuation can try to resume it.
    // The post-abort server-side session has: [prior context + assistant
    // tool_use + MCP tool_result("Forwarded...") + maybe partial reply].
    // Resuming with the real tool result works if the model treats the new
    // user message as authoritative; if the post-abort state is incoherent,
    // the retry-as-fresh logic in the catch handler recovers.
    if (SESSIONS_ENABLED && capturedSessionId) {
      if (strategy.mode === 'resume')
        sessionRegistry.invalidate(strategy.lookupKey)
      sessionRegistry.remember(sessionStoreKey(request.messages), capturedSessionId)
    }

    if (res.writableEnded)
      return
    if (streaming) {
      res.write(`data: ${toolCallChunkOf(completionId, model, capturedCalls)}\n\n`)
      res.write(`data: ${finalChunkOf(completionId, model, undefined, 'tool_calls')}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
    else {
      respondJson(res, 200, completionOf(completionId, model, fullText, undefined, capturedCalls))
    }
  }

  // At most 2 attempts: the first may be a resume that fails (post-abort
  // session incoherent), the second replays full history as fresh.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      for await (const message of generation) {
        if ('session_id' in message && typeof message.session_id === 'string' && message.session_id)
          capturedSessionId = message.session_id

        if (message.type === 'stream_event') {
          const event = message.event
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
            streamedAnyDelta = true
            fullText += event.delta.text
            if (streaming)
              res.write(`data: ${chunkOf(completionId, model, event.delta.text)}\n\n`)
          }
          else if (FORWARD_THINKING && streaming && event.type === 'content_block_delta' && event.delta.type === 'thinking_delta' && event.delta.thinking) {
            res.write(`data: ${reasoningChunkOf(completionId, model, event.delta.thinking)}\n\n`)
          }
          continue
        }

        if (message.type === 'result') {
          if (message.subtype !== 'success') {
            const errorText = 'errors' in message && message.errors?.length
              ? JSON.stringify(message.errors)
              : message.subtype
            throw new Error(`Claude Code query failed: ${errorText}`)
          }

          if (capturedCalls.length > 0) {
            respondCapturedToolCalls()
            return
          }

          if (message.usage) {
            log.withFields({
              input: message.usage.input_tokens,
              output: message.usage.output_tokens,
              cacheRead: message.usage.cache_read_input_tokens,
              cacheCreate: message.usage.cache_creation_input_tokens,
            }).log('result cache accounting')
          }

          if (SESSIONS_ENABLED && capturedSessionId) {
            if (strategy.mode === 'resume')
              sessionRegistry.invalidate(strategy.lookupKey)
            sessionRegistry.remember(sessionStoreKey(request.messages), capturedSessionId)
          }

          fullText = message.result
          if (streaming && !streamedAnyDelta && fullText)
            res.write(`data: ${chunkOf(completionId, model, fullText)}\n\n`)

          if (streaming) {
            res.write(`data: ${finalChunkOf(completionId, model, message.usage)}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          }
          else {
            respondJson(res, 200, completionOf(completionId, model, fullText, message.usage))
          }
          return
        }
      }

      if (capturedCalls.length > 0) {
        respondCapturedToolCalls()
        return
      }
      throw new Error('Claude Code query ended without a result')
    }
    catch (error) {
      if (capturedCalls.length > 0) {
        respondCapturedToolCalls()
        return
      }

      if (abortController.signal.aborted) {
        log.log('Request aborted by client')
        if (!res.writableEnded)
          res.end()
        return
      }

      // Retry-as-fresh: when a resume failed before any data was streamed,
      // replay full history instead of surfacing the error to the user. This
      // covers post-abort session incoherence (tool-result resume) and stale
      // sessions evicted from the SDK's on-disk store.
      if (strategy.mode === 'resume' && !streamedAnyDelta && attempt === 0) {
        sessionRegistry.invalidate(strategy.lookupKey)
        log.withError(error as Error).warn('resume failed, retrying as fresh')

        const freshComposed = composeQueryInput(request.messages, { maxHistoryRounds: MAX_HISTORY_ROUNDS })
        systemPrompt = freshComposed.systemPrompt
        blocks = freshComposed.blocks

        strategy = { mode: 'fresh' }
        abortController = new AbortController()
        capturedCalls = []
        capturedSessionId = undefined

        generation = query({
          prompt: promptStreamOf(blocks),
          options: {
            abortController,
            systemPrompt,
            ...baseQueryOptions(model, streaming),
            maxTurns: requestTools.length > 0 ? 2 : 1,
            mcpServers: buildMcpServers(),
            allowedTools: requestTools.map(definition => `mcp__airi__${definition.function.name}`),
          },
        })
        continue
      }

      if (strategy.mode === 'resume')
        sessionRegistry.invalidate(strategy.lookupKey)

      log.withError(error as Error).error('Chat completion failed')
      if (streaming && res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: { message: String((error as Error).message) } })}\n\n`)
        res.end()
      }
      else if (!res.headersSent) {
        respondError(res, 500, String((error as Error).message))
      }
      return
    }
    finally {
      if (captureAbortTimer) {
        clearTimeout(captureAbortTimer)
        captureAbortTimer = undefined
      }
    }
  }
}

const server = http.createServer(async (req, res) => {
  writeCors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // The socket is bound before the egress guard has finished (so an
  // already-running instance can be detected without prompting first), so
  // refuse real work until it clears. Without this, a request arriving in that
  // window would reach Anthropic from exactly the exit the guard is checking.
  if (!egressGateCleared) {
    respondError(res, 503, 'claude-code-brain is verifying its exit IP — see the service logs')
    return
  }

  const url = new URL(req.url || '/', 'http://localhost')

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    await handleModels(res)
    return
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await handleChatCompletions(req, res)
    return
  }

  respondError(res, 404, `No route for ${req.method} ${url.pathname}`)
})

/**
 * Ask the terminal a question, or give up.
 *
 * Returns `null` when there is no interactive stdin — the bridge is usually
 * spawned by a dev script or the desktop app, and in that case the manual
 * override must be impossible rather than silently auto-answered.
 */
async function askOperator(question: string): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return null

  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    // A prompt left open forever would hang a `pnpm dev` shell; abandoning it
    // counts as "no answer", which the guard treats as decline.
    return await rl.question(question, { signal: AbortSignal.timeout(EGRESS_CONFIRM_TIMEOUT_MS) })
  }
  catch {
    return null
  }
  finally {
    rl.close()
  }
}

/**
 * Decide whether this process may serve Claude traffic from the current exit.
 *
 * Order matters: the socket is already bound at this point, so a duplicate
 * instance has exited quietly through the EADDRINUSE path above without ever
 * prompting — the operator only sees a question when this really is the
 * instance that would talk to Anthropic.
 */
async function clearEgressGate(): Promise<boolean> {
  if (!EGRESS_CHECK_ENABLED) {
    log.log('exit IP check disabled (CLAUDE_BRAIN_EGRESS_CHECK=0)')
    return true
  }

  const allowed = parseAllowedEgressIps(process.env.CLAUDE_BRAIN_EGRESS_IPS)
  const probe = await probeEgressIp({
    url: process.env.CLAUDE_BRAIN_EGRESS_URL,
    env: process.env,
  })
  const verdict = decideEgress({ allowed, probe })

  if (probe.proxyEnvVars.length > 0) {
    // NOTICE:
    // Node's fetch ignores proxy env vars; the Claude CLI the Agent SDK spawns
    // honours them. With those set, this probe measured the direct route and
    // the SDK may leave through a different one, so the verdict below is about
    // the wrong path. A transparent/TUN proxy has no such split.
    log.withFields({ proxyEnvVars: probe.proxyEnvVars }).warn('proxy env vars are set — this probe went direct, so it may not reflect the exit the Claude SDK uses')
  }

  if (verdict.decision === 'allowed') {
    log.withFields({ exitIp: verdict.detected }).log('exit IP check passed')
    return true
  }

  if (verdict.decision === 'unconfigured') {
    log.withFields({ exitIp: verdict.detected ?? 'unknown' }).warn('exit IP not pinned — set CLAUDE_BRAIN_EGRESS_IPS in services/claude-code-brain/.env to enable the check')
    return true
  }

  log.withFields({ expected: allowed.join(', '), detected: verdict.detected ?? 'unknown', reason: verdict.reason })
    .error('refusing to start: the exit IP is not the pinned one')

  const confirmed = await confirmStartDespiteEgress({ detected: verdict.detected, ask: askOperator })
  if (confirmed) {
    log.withFields({ exitIp: verdict.detected ?? 'unknown' }).warn('operator confirmed manually — starting from an unpinned exit')
    return true
  }

  log.log('not started. Re-run once the expected exit is back, update CLAUDE_BRAIN_EGRESS_IPS, or start with CLAUDE_BRAIN_EGRESS_CHECK=0')
  return false
}

// NOTICE:
// `pnpm dev` / `pnpm dev:tamagotchi` start this bridge in parallel with the
// stage apps. If another instance is already serving the port (started
// manually or from a second dev shell), exit quietly and let AIRI use that
// one — crashing here would take the whole parallel dev run down with it.
// Removal condition: brain no longer auto-started from the root dev scripts.
server.once('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    log.withFields({ port: PORT }).log('port already in use — another claude-code-brain instance is serving, reusing it')
    process.exit(0)
  }
  throw error
})

/**
 * Purge session files left by previous runs. The in-memory registry starts
 * empty, so any on-disk sessions are stale — the server-side sessions they
 * point to have long expired (5 min TTL on the Anthropic side).
 */
async function purgeStaleSessionFiles(): Promise<void> {
  try {
    const sessions = await listSessions({ dir: process.cwd() })
    if (sessions.length === 0)
      return
    log.withFields({ count: sessions.length }).log('purging stale session files from previous runs')
    await Promise.allSettled(sessions.map(s => deleteSession(s.sessionId, { dir: process.cwd() })))
  }
  catch {
    // Best effort; the directory may not exist yet on first run.
  }
}

server.listen(PORT, '127.0.0.1', () => {
  void clearEgressGate().then((cleared) => {
    if (!cleared) {
      server.close()
      process.exit(1)
    }

    egressGateCleared = true
    log.withFields({ port: PORT, effort: EFFORT, forwardThinking: FORWARD_THINKING, maxHistoryRounds: MAX_HISTORY_ROUNDS ?? 'unlimited', sessions: SESSIONS_ENABLED }).log('claude-code-brain listening — point AIRI\'s OpenAI-compatible provider at this URL')
    log.log(`  baseUrl: http://localhost:${PORT}/v1/`)

    void purgeStaleSessionFiles()
  })
})
