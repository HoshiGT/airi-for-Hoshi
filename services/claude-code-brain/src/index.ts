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

import type { CapturedToolCall, OpenAIChatRequest, PromptBlock } from './translate'

import http from 'node:http'
import process from 'node:process'

import { Buffer } from 'node:buffer'

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { Format, LogLevel, useLogg } from '@guiiai/logg'

import { decideStrategy, SessionRegistry, sessionStoreKey } from './sessions'
import { estimateQueryTokens } from './token-estimate'
import { ADVERTISED_MODELS, chunkOf, completionOf, composeCurrentRound, composeQueryInput, composeSystemPrompt, finalChunkOf, jsonSchemaToZodShape, reasoningChunkOf, resolveModelOption, toolCallChunkOf } from './translate'

const log = useLogg('ClaudeCodeBrain').withLogLevel(LogLevel.Log).withFormat(Format.Pretty)

const PORT = Number(process.env.CLAUDE_BRAIN_PORT || 14515)

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

// Process-lifetime conversation→session map. In-memory only: a miss just costs
// one uncached turn, so it need not survive restarts.
const sessionRegistry = new SessionRegistry()

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
  const strategy = SESSIONS_ENABLED ? decideStrategy(request.messages, sessionRegistry) : { mode: 'fresh' as const }
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
    // Names make it obvious which enabled modules drive the tool cost — one
    // module can register several tools (e.g. desktop-control → look/mouse/keyboard).
    toolNames: requestTools.map(definition => definition.function.name).join(','),
    total: tokens.totalTokens,
  }).log('query input token estimate (~chars/3.5)')

  // Client hang-ups (AIRI cancelling a generation) must kill the underlying
  // Claude Code turn too, or abandoned turns keep burning subscription quota.
  const abortController = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded)
      abortController.abort()
  })

  // Tool passthrough: register AIRI's tools as capture-only MCP tools. The
  // handler records the call and schedules an abort instead of executing —
  // execution belongs to AIRI's side of the wire (xdotool, screenshots, ...).
  const capturedCalls: CapturedToolCall[] = []
  let captureAbortTimer: NodeJS.Timeout | undefined
  const mcpServers = requestTools.length > 0
    ? {
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
    : undefined

  const generation = query({
    prompt: promptStreamOf(blocks),
    options: {
      abortController,
      systemPrompt,
      // Resume replays the session's history server-side (cache-read); only the
      // current-round blocks above go on the wire. Omitted on the fresh path.
      ...(strategy.mode === 'resume' ? { resume: strategy.sessionId } : {}),
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
      // No built-in Claude Code tools ever: Airi's brain must not touch the
      // filesystem or terminal. Airi's own tools arrive via mcpServers above.
      tools: [],
      // 2 turns in tool mode: the SDK only invokes MCP handlers when the loop
      // is allowed to continue past the tool-calling assistant turn.
      maxTurns: requestTools.length > 0 ? 2 : 1,
      mcpServers,
      // Auto-allow the passthrough tools; the real permission decision happens
      // in AIRI (and the handlers execute nothing anyway).
      allowedTools: requestTools.map(definition => `mcp__airi__${definition.function.name}`),
      // SDK isolation mode: without this the subprocess loads ~/.claude
      // settings and the user's global CLAUDE.md memory, leaking coding
      // context (and the user's identity) into Airi's persona.
      settingSources: [],
      includePartialMessages: streaming,
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
  // Captured from the SDK stream (every message carries it) to remember/resume
  // this conversation's session on the next turn.
  let capturedSessionId: string | undefined

  const respondCapturedToolCalls = () => {
    // The tool-call turn aborted mid-reply, leaving any resumed session
    // inconsistent (assistant emitted tool_use, no tool_result), so drop it —
    // the next turn (tool result) replays full history via the fresh path.
    if (strategy.mode === 'resume')
      sessionRegistry.invalidate(strategy.lookupKey)

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
        // Thinking deltas are dropped unless FORWARD_THINKING opted in: by
        // default they are Claude's private reasoning and must not leak into
        // Airi's chat bubble. When forwarded they go out as `reasoning_content`
        // (never as text content), so AIRI shows them as a reasoning line and
        // keeps them out of the replayed history. Streaming-only by nature:
        // partial events exist only when `includePartialMessages` is on, and
        // the non-stream result carries final text alone.
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

        // A capture can settle without the abort having killed the query yet
        // (e.g. the model produced its result within the grace window).
        if (capturedCalls.length > 0) {
          respondCapturedToolCalls()
          return
        }

        // Phase A measurement (plan: sequential-leaping-wombat): surface the
        // SDK's cache accounting each turn so caching effectiveness is provable.
        // With a fresh query() per request (today) cache_read stays ~0 and every
        // input token is repriced — this is the baseline the session-resume work
        // must move. cache_read_input_tokens billed at ~10%, so a high ratio here
        // is the cost win.
        if (message.usage) {
          log.withFields({
            input: message.usage.input_tokens,
            output: message.usage.output_tokens,
            cacheRead: message.usage.cache_read_input_tokens,
            cacheCreate: message.usage.cache_creation_input_tokens,
          }).log('result cache accounting')
        }

        // Remember the session so the next turn of this conversation resumes it
        // (send only the new turn → cache-read prefix). Keyed by the user-message
        // sequence so it survives AIRI stripping markers/reasoning from replays.
        // On resume, the old key is dropped so at most one key lives per turn.
        if (SESSIONS_ENABLED && capturedSessionId) {
          if (strategy.mode === 'resume')
            sessionRegistry.invalidate(strategy.lookupKey)
          sessionRegistry.remember(sessionStoreKey(request.messages), capturedSessionId)
        }

        fullText = message.result
        // Partial events are best-effort; if none arrived (or streaming was
        // off), the final result text is the single source of truth.
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

    // Generator ended without a result: either our capture-abort cut it short
    // (expected in tool mode) or the subprocess died.
    if (capturedCalls.length > 0) {
      respondCapturedToolCalls()
      return
    }
    throw new Error('Claude Code query ended without a result')
  }
  catch (error) {
    // The capture path aborts on purpose; surface the tool calls, not the abort.
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

    // Self-heal a bad resume: if a resumed session errored (e.g. it was evicted
    // from the SDK's on-disk store), drop it so the next turn replays full
    // history via the fresh path instead of failing again.
    if (strategy.mode === 'resume')
      sessionRegistry.invalidate(strategy.lookupKey)

    log.withError(error as Error).error('Chat completion failed')
    if (streaming && res.headersSent) {
      // Headers are out; surface the failure inside the stream so AIRI shows
      // an error instead of hanging on a half-open connection.
      res.write(`data: ${JSON.stringify({ error: { message: String((error as Error).message) } })}\n\n`)
      res.end()
    }
    else if (!res.headersSent) {
      respondError(res, 500, String((error as Error).message))
    }
  }
  finally {
    if (captureAbortTimer)
      clearTimeout(captureAbortTimer)
  }
}

const server = http.createServer(async (req, res) => {
  writeCors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
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

server.listen(PORT, '127.0.0.1', () => {
  log.withFields({ port: PORT, effort: EFFORT, forwardThinking: FORWARD_THINKING, maxHistoryRounds: MAX_HISTORY_ROUNDS ?? 'unlimited', sessions: SESSIONS_ENABLED }).log('claude-code-brain listening — point AIRI\'s OpenAI-compatible provider at this URL')
  log.log(`  baseUrl: http://localhost:${PORT}/v1/`)
})
