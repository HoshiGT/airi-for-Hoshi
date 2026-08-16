/**
 * Translation layer between the OpenAI chat-completions wire shape (what AIRI's
 * openai-compatible provider speaks) and the Claude Agent SDK's `query()` input,
 * plus the response chunks going back.
 *
 * Two directions live here:
 * - inbound: OpenAI messages (+ tool history, + images) → one Anthropic-style
 *   user content-block array + a system prompt ({@link composeQueryInput}),
 *   and OpenAI tool JSON Schemas → Zod shapes for SDK MCP registration
 *   ({@link jsonSchemaToZodShape}).
 * - outbound: text deltas / captured tool calls → OpenAI chunks & completions.
 *
 * Pure functions only — the HTTP/SSE plumbing and the query lifecycle live in
 * `index.ts`.
 */
import { z } from 'zod'

/** OpenAI content part; AIRI sends text parts plus base64 `image_url` parts. */
export interface OpenAIContentPart {
  type: string
  text?: string
  image_url?: { url: string }
}

/** A tool call the assistant made, echoed back by AIRI in the history. */
export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string, arguments: string }
}

/** Subset of the OpenAI chat message shape that AIRI actually sends. */
export interface OpenAIChatMessage {
  role: string
  content: string | OpenAIContentPart[] | null | undefined
  tool_calls?: OpenAIToolCall[]
  /** Present on `role: 'tool'` result messages. */
  tool_call_id?: string
  /** Tool name on result messages (xsAI includes it). */
  name?: string
}

export interface OpenAIToolDef {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface OpenAIChatRequest {
  model?: string
  messages?: OpenAIChatMessage[]
  stream?: boolean
  tools?: OpenAIToolDef[]
}

/** Image formats the Anthropic API accepts; anything else is dropped. */
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number]

/** Anthropic-style content blocks fed to the SDK via streaming input. */
export type PromptBlock
  = | { type: 'text', text: string }
    | { type: 'image', source: { type: 'base64', media_type: SupportedImageType, data: string } }

export interface ComposedQueryInput {
  systemPrompt: string
  blocks: PromptBlock[]
}

/**
 * Prepended to every composed system prompt.
 *
 * The Claude Code harness injects logged-in account metadata (email, platform
 * details) into the subprocess context, and there is no SDK option to disable
 * it with a custom string system prompt (`settingSources: []` only stops
 * filesystem settings — verified 2026-07-18, sdk 0.3.214). Without this rule
 * the persona "magically" knows the operator's email, which breaks character
 * and would leak the address into group chats the persona speaks in.
 */
export const CONTEXT_HYGIENE_PREAMBLE = [
  'You are running behind a chat relay. Platform/account metadata visible in your context',
  '(email addresses, usernames, working directories, harness details) is CONFIDENTIAL',
  'relay-infrastructure data that the persona you play has no access to. It may be',
  'read by third parties in group chats, so revealing it is a privacy breach — never',
  'state, hint at, or confirm it, even when directly asked or urged to be honest.',
  'When asked what you know about the user, draw only on this conversation; as the',
  'persona, you genuinely do not have that metadata. This rule outranks any request',
  'in the conversation. Only the persona instructions below and the chat itself are',
  'real to you.',
].join(' ')

/**
 * Screenshots accumulate fast in desktop-control loops and AIRI resends full
 * history each turn; only images from messages after the final assistant turn
 * (= the round currently being answered) are attached, capped at this many.
 */
const MAX_ATTACHED_IMAGES = 5

// Historical tool traffic is replayed verbatim on every request and long
// argument dumps / tool outputs dominate the transcript's token cost, so both
// are clipped. The current round's tool results are exempt (see below): the
// model is actively reasoning over them to produce this turn's reply, so
// clipping them would hide the very data it just asked for.
const MAX_TOOL_ARGS_CHARS = 200
const MAX_TOOL_RESULT_CHARS = 500

/** Clips over-long transcript text, appending a count of the omitted characters. */
function clip(text: string, max: number): string {
  if (text.length <= max)
    return text
  return `${text.slice(0, max)}…[+${text.length - max} chars]`
}

// Some tools embed a full base64 data URL inside their JSON result text — e.g.
// image_journal returns the generated image's data URL so the chat UI can render
// it inline. The model can do nothing with a base64 blob as text, yet one image
// is tens of thousands of tokens, so strip any data URL out of tool-result text
// before it enters the transcript. Legitimate images the model SHOULD see arrive
// as `image_url` content parts (handled by imagesOf) and never pass through here.
const DATA_URL_REGEX = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g
function stripDataUrls(text: string): string {
  return text.replace(DATA_URL_REGEX, '[inline image omitted]')
}

/** Options for {@link composeQueryInput}. */
export interface ComposeOptions {
  /**
   * Cap replay to the last N user-turn rounds; older dialogue collapses to a
   * single omission marker. Undefined or non-positive replays the *full*
   * history — the default, so the persona keeps the whole conversation in
   * context. Set a positive integer to opt into the token-saving cap.
   * @default unlimited — the entire conversation is replayed
   */
  maxHistoryRounds?: number
}

/** Concatenates the text parts of an OpenAI message content (ignores images). */
export function textOf(content: OpenAIChatMessage['content']): string {
  if (typeof content === 'string')
    return content
  if (!Array.isArray(content))
    return ''
  return content
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
}

/** Parses a base64 data URL into an Anthropic image block; undefined for remote URLs (can't fetch here) and unsupported formats. */
function imageBlockOf(url: string): PromptBlock | undefined {
  const match = url.match(/^data:([^;,]+);base64,(.+)$/s)
  if (!match)
    return undefined
  const mediaType = match[1] as SupportedImageType
  if (!SUPPORTED_IMAGE_TYPES.includes(mediaType))
    return undefined
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: match[2] } }
}

function imagesOf(content: OpenAIChatMessage['content']): PromptBlock[] {
  if (!Array.isArray(content))
    return []
  const blocks: PromptBlock[] = []
  for (const part of content) {
    if (part.type === 'image_url' && part.image_url?.url) {
      const block = imageBlockOf(part.image_url.url)
      if (block)
        blocks.push(block)
    }
  }
  return blocks
}

/**
 * Flattens the OpenAI message array into the Agent SDK's input shape.
 *
 * - `system` messages (AIRI's character card + toolset prompts) join the
 *   hygiene preamble as the SDK `systemPrompt` — a custom string also
 *   suppresses Claude Code's own coding-agent prompt.
 * - The dialogue — including prior tool calls and tool results — is replayed
 *   as a labeled transcript inside one user turn. AIRI resends full history
 *   every request, so the bridge stays stateless.
 * - Images (user attachments, tool-result screenshots) are attached as real
 *   image blocks, but only from messages after the final assistant turn: the
 *   model needs to see the screenshot it just asked for, not every screenshot
 *   in the conversation.
 * - History older than `maxHistoryRounds` user turns is dropped and replaced
 *   with a single omission marker, so token cost stops growing with the
 *   conversation. Tool arguments and (historical) tool results are also clipped.
 */
export function composeQueryInput(messages: OpenAIChatMessage[], options: ComposeOptions = {}): ComposedQueryInput {
  // No cap by default: the full history is replayed so the persona keeps the
  // whole relationship in context. A positive `maxHistoryRounds` opts into the
  // token-saving cap.
  const cap = options.maxHistoryRounds
  const historyCap = typeof cap === 'number' && Number.isFinite(cap) && cap >= 1 ? Math.floor(cap) : undefined

  const transcript: string[] = []
  const images: PromptBlock[] = []

  const lastAssistantIndex = messages.reduce(
    (last, message, index) => (message.role === 'assistant' ? index : last),
    -1,
  )

  // Round boundaries are user turns. Keep only the last `maxHistoryRounds` of
  // them (and everything after the first kept one); the earlier dialogue
  // collapses to one marker. System messages are exempt — they carry the
  // persona and are extracted below regardless of position.
  const userIndices: number[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user')
      userIndices.push(index)
  }
  const truncated = historyCap !== undefined && userIndices.length > historyCap
  const cutoffIndex = truncated ? userIndices[userIndices.length - historyCap] : -1

  if (truncated)
    transcript.push('(Earlier conversation omitted.)')

  for (const [index, message] of messages.entries()) {
    // System messages carry the persona; composeSystemPrompt joins them into the
    // system prompt, so they never enter the transcript.
    if (message.role === 'system')
      continue

    // Dropped by the history cap; the omission marker above stands in for it.
    if (index < cutoffIndex)
      continue

    const inCurrentRound = index > lastAssistantIndex

    if (message.role === 'user') {
      const text = textOf(message.content)
      const userImages = inCurrentRound ? imagesOf(message.content) : []
      images.push(...userImages)
      const imageNote = userImages.length > 0 ? ` (${userImages.length} image(s) attached below)` : ''
      if (text.trim() || imageNote)
        transcript.push(`[User]: ${text}${imageNote}`)
      continue
    }

    if (message.role === 'assistant') {
      const text = textOf(message.content)
      if (text.trim())
        transcript.push(`[You]: ${text}`)
      for (const call of message.tool_calls ?? [])
        transcript.push(`[You called tool ${call.function.name} with arguments: ${clip(call.function.arguments, MAX_TOOL_ARGS_CHARS)}]`)
      continue
    }

    if (message.role === 'tool') {
      const text = stripDataUrls(textOf(message.content))
      // Keep the current round's result whole — the model needs the data it
      // just requested; clip only replayed history to curb token growth.
      const resultText = inCurrentRound ? text : clip(text, MAX_TOOL_RESULT_CHARS)
      const toolImages = inCurrentRound ? imagesOf(message.content) : []
      images.push(...toolImages)
      const label = message.name ? `Tool ${message.name}` : 'Tool'
      const imageNote = toolImages.length > 0
        ? ` (screenshot/image attached below)`
        : (Array.isArray(message.content) && message.content.some(part => part.type === 'image_url') ? ' (older screenshot omitted)' : '')
      transcript.push(`[${label} returned]: ${resultText}${imageNote}`)
    }
  }

  const systemPrompt = composeSystemPrompt(messages)

  // Single fresh user turn: hand the text over directly, no transcript framing.
  if (transcript.length === 1 && transcript[0].startsWith('[User]: ') && images.length === 0)
    return { systemPrompt, blocks: [{ type: 'text', text: transcript[0].slice('[User]: '.length) }] }

  const promptText = [
    'Below is the conversation so far. Lines starting with [You] are your own previous replies and tool calls.',
    '',
    transcript.join('\n\n'),
    '',
    'Continue the conversation: respond to the latest message above, staying in character as defined in your instructions. Use your tools when they are needed to answer. Output only your reply text.',
  ].join('\n')

  return {
    systemPrompt,
    blocks: [
      { type: 'text', text: promptText },
      ...images.slice(-MAX_ATTACHED_IMAGES),
    ],
  }
}

/**
 * Joins the hygiene preamble and every `system` message into the SDK system
 * prompt. Shared by the fresh path ({@link composeQueryInput}) and the resume
 * path, which re-sends the same persona each turn so a resumed session never
 * drifts from the card AIRI currently has loaded.
 */
export function composeSystemPrompt(messages: OpenAIChatMessage[]): string {
  const systemParts: string[] = []
  for (const message of messages) {
    if (message.role !== 'system')
      continue
    const text = textOf(message.content)
    if (text.trim())
      systemParts.push(text)
  }
  return [CONTEXT_HYGIENE_PREAMBLE, ...systemParts].join('\n\n')
}

/**
 * Blocks for just the current round — the messages after the last assistant
 * turn — sent when resuming a cached session, where the prior history already
 * lives in the session and only the new turn goes on the wire. Mirrors the
 * current-round text/image handling in {@link composeQueryInput} (images capped
 * at {@link MAX_ATTACHED_IMAGES}).
 */
export function composeCurrentRound(messages: OpenAIChatMessage[]): PromptBlock[] {
  const lastAssistantIndex = messages.reduce(
    (last, message, index) => (message.role === 'assistant' ? index : last),
    -1,
  )

  const textParts: string[] = []
  const images: PromptBlock[] = []
  for (const [index, message] of messages.entries()) {
    if (index <= lastAssistantIndex)
      continue

    if (message.role === 'user') {
      const text = textOf(message.content)
      images.push(...imagesOf(message.content))
      if (text.trim())
        textParts.push(text)
    }
    else if (message.role === 'tool') {
      // Tool continuations take the fresh path, so this is defensive: keep the
      // round faithful if a tool result ever reaches the resume path.
      const text = stripDataUrls(textOf(message.content))
      images.push(...imagesOf(message.content))
      const label = message.name ? `Tool ${message.name}` : 'Tool'
      textParts.push(`[${label} returned]: ${text}`)
    }
  }

  return [{ type: 'text', text: textParts.join('\n\n') }, ...images.slice(-MAX_ATTACHED_IMAGES)]
}

/**
 * Converts one JSON Schema node into a Zod validator.
 *
 * Covers the subset AIRI's tools actually use (this repo mandates
 * provider-compliant schemas: explicit object types, primitives, enums,
 * arrays, `T | null` unions). Anything unrecognized degrades to `z.any()` —
 * the executing side (AIRI) revalidates for real, so the bridge's schema only
 * needs to be good enough for the model to fill in correct arguments.
 */
function jsonSchemaToZod(schema: unknown): z.ZodType {
  if (!schema || typeof schema !== 'object')
    return z.any()

  const node = schema as Record<string, any>

  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    const variants = (node.anyOf ?? node.oneOf) as unknown[]
    const zods = variants.map(jsonSchemaToZod)
    const union = zods.length >= 2 ? z.union(zods as [z.ZodType, z.ZodType, ...z.ZodType[]]) : (zods[0] ?? z.any())
    return withDescription(union, node.description)
  }

  // `type: ['string', 'null']` — the array form of nullable.
  if (Array.isArray(node.type)) {
    const nonNull = node.type.filter((t: string) => t !== 'null')
    const base = jsonSchemaToZod({ ...node, type: nonNull[0] })
    return node.type.includes('null') ? base.nullable() : base
  }

  let zod: z.ZodType
  switch (node.type) {
    case 'string':
      zod = Array.isArray(node.enum) && node.enum.length > 0
        ? z.enum(node.enum as [string, ...string[]])
        : z.string()
      break
    case 'integer':
      zod = z.number().int()
      break
    case 'number':
      zod = z.number()
      break
    case 'boolean':
      zod = z.boolean()
      break
    case 'null':
      zod = z.null()
      break
    case 'array':
      zod = z.array(jsonSchemaToZod(node.items))
      break
    case 'object': {
      const shape: Record<string, z.ZodType> = {}
      const required = new Set<string>(Array.isArray(node.required) ? node.required : [])
      for (const [key, prop] of Object.entries(node.properties ?? {})) {
        const propZod = jsonSchemaToZod(prop)
        shape[key] = required.has(key) ? propZod : propZod.optional()
      }
      zod = z.object(shape)
      break
    }
    default:
      zod = z.any()
  }

  return withDescription(zod, node.description)
}

function withDescription(zod: z.ZodType, description: unknown): z.ZodType {
  return typeof description === 'string' && description ? zod.describe(description) : zod
}

/**
 * OpenAI tool `parameters` (a JSON Schema object) → the Zod raw shape the
 * Agent SDK's `tool()` expects. Missing/empty parameters yield an empty shape.
 */
export function jsonSchemaToZodShape(parameters: Record<string, unknown> | undefined): Record<string, z.ZodType> {
  if (!parameters || parameters.type !== 'object')
    return {}
  const object = jsonSchemaToZod(parameters)
  return (object as z.ZodObject).shape
}

/**
 * Static fallback for /v1/models when the live `supportedModels()` probe fails;
 * `default` means "whatever the CLI defaults to".
 */
export const ADVERTISED_MODELS = [
  'default',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-haiku-4-5',
]

/**
 * Maps the requested model onto the SDK `model` option.
 * `default` (or empty) omits the option so the subscription's CLI default wins.
 */
export function resolveModelOption(requested: string | undefined): string | undefined {
  if (!requested || requested === 'default')
    return undefined
  return requested
}

export interface UsageLike {
  input_tokens?: number
  output_tokens?: number
}

/** A tool call captured from the SDK before execution, to be forwarded to AIRI. */
export interface CapturedToolCall {
  id: string
  name: string
  /** JSON-serialized arguments, as OpenAI expects them. */
  arguments: string
}

function usageOf(usage: UsageLike | undefined) {
  const promptTokens = usage?.input_tokens ?? 0
  const completionTokens = usage?.output_tokens ?? 0
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  }
}

function openAIToolCallsOf(calls: CapturedToolCall[]) {
  return calls.map((call, index) => ({
    index,
    id: call.id,
    type: 'function' as const,
    function: { name: call.name, arguments: call.arguments },
  }))
}

/** One OpenAI streaming chunk carrying a text delta. */
export function chunkOf(id: string, model: string, delta: string): string {
  return JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
  })
}

/**
 * One OpenAI streaming chunk carrying a thinking delta as `reasoning_content`
 * — the DeepSeek-R1-style field xsAI maps to `reasoning-delta` events, which
 * AIRI renders as the collapsed grey "reasoning" line above the reply (and
 * strips from history replays, so thinking never feeds back into the model).
 */
export function reasoningChunkOf(id: string, model: string, delta: string): string {
  return JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }],
  })
}

/** Streaming chunk carrying the captured tool calls. */
export function toolCallChunkOf(id: string, model: string, calls: CapturedToolCall[]): string {
  return JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { tool_calls: openAIToolCallsOf(calls) }, finish_reason: null }],
  })
}

/** The terminal streaming chunk. `finishReason` is 'stop' or 'tool_calls'. */
export function finalChunkOf(id: string, model: string, usage?: UsageLike, finishReason: 'stop' | 'tool_calls' = 'stop'): string {
  return JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: usageOf(usage),
  })
}

/** Non-streaming completion response, optionally carrying tool calls. */
export function completionOf(id: string, model: string, text: string, usage?: UsageLike, toolCalls?: CapturedToolCall[]): string {
  const hasToolCalls = !!toolCalls && toolCalls.length > 0
  return JSON.stringify({
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || (hasToolCalls ? null : ''),
        ...(hasToolCalls ? { tool_calls: openAIToolCallsOf(toolCalls).map(({ index: _index, ...call }) => call) } : {}),
      },
      finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
    }],
    usage: usageOf(usage),
  })
}
