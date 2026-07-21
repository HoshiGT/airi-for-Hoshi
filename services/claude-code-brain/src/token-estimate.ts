/**
 * Rough token accounting for the query about to be sent to the subscription,
 * logged so quota drain is visible per request without wiring the real
 * tokenizer. It uses a chars-per-token heuristic — precision is not the goal;
 * spotting which component (system prompt, transcript, images, tools) dominates
 * a request is. Pure functions only; the logging happens in `index.ts`.
 */
import type { OpenAIToolDef, PromptBlock } from './translate'

// English/Chinese mixed chat text lands around this many characters per token
// for Anthropic's tokenizer. A single divisor is deliberately crude: it keeps
// the estimate stable and comparable across requests.
const CHARS_PER_TOKEN = 3.5

// Image cost really scales with pixel area (~ (width*height)/750 per Anthropic),
// which we cannot read from a base64 blob cheaply. The base64 payload length
// tracks that within an order of magnitude for typical screenshots — enough to
// flag images as the dominant cost when they are one. Not an exact bill.
const IMAGE_CHARS_PER_TOKEN = 750

/** Per-component token estimate for one composed query. */
export interface TokenBreakdown {
  /** System prompt (hygiene preamble + character card + toolset prompts). */
  systemPromptTokens: number
  /** The replayed dialogue transcript (all text blocks). */
  transcriptTokens: number
  /** Attached image blocks, estimated from base64 payload size. */
  imageTokens: number
  /** Registered tool JSON Schemas the SDK sends as tool definitions. */
  toolTokens: number
  /** Number of attached image blocks (for the log; not a token count). */
  imageCount: number
  /** Sum of all component token estimates. */
  totalTokens: number
}

/** Input to {@link estimateQueryTokens}; mirrors what `index.ts` hands to `query()`. */
export interface EstimateInput {
  systemPrompt: string
  blocks: PromptBlock[]
  tools: OpenAIToolDef[]
}

function estimateTextTokens(text: string): number {
  return Math.round(text.length / CHARS_PER_TOKEN)
}

/**
 * Estimates the token footprint of a composed query, split by component so the
 * request log shows where the budget goes.
 */
export function estimateQueryTokens(input: EstimateInput): TokenBreakdown {
  const systemPromptTokens = estimateTextTokens(input.systemPrompt)

  let transcriptTokens = 0
  let imageTokens = 0
  let imageCount = 0
  for (const block of input.blocks) {
    if (block.type === 'text') {
      transcriptTokens += estimateTextTokens(block.text)
    }
    else {
      imageCount += 1
      imageTokens += Math.round(block.source.data.length / IMAGE_CHARS_PER_TOKEN)
    }
  }

  // The SDK serializes each tool's name/description/parameters into the request;
  // the function object is the closest stand-in for that wire payload.
  const toolTokens = input.tools.reduce(
    (sum, tool) => sum + estimateTextTokens(JSON.stringify(tool.function)),
    0,
  )

  const totalTokens = systemPromptTokens + transcriptTokens + imageTokens + toolTokens
  return { systemPromptTokens, transcriptTokens, imageTokens, toolTokens, imageCount, totalTokens }
}
