import type { Message } from '@xsai/shared-chat'

import { generateText } from '@xsai/generate-text'

export interface LLMConfig {
  baseURL: string
  apiKey: string
  model: string
  /** Forwarded as `reasoning_effort`; omitted from the request when undefined. */
  reasoningEffort?: ReasoningEffort
}

/** Values @xsai/shared-chat accepts for `reasoningEffort`. Note it has no `low`. */
export type ReasoningEffort = 'none' | 'minimal' | 'medium' | 'high' | 'xhigh'

export interface LLMCallOptions {
  messages: Message[]
  responseFormat?: { type: 'json_object' }
  /** Overrides {@link LLMConfig.reasoningEffort} for one call. */
  reasoningEffort?: ReasoningEffort
  abortSignal?: AbortSignal
  timeoutMs?: number
}

export interface LLMResult {
  text: string
  reasoning?: string
  // FIXME unsafe type
  usage: any
}

/**
 * Lightweight LLM agent for text generation using xsai
 */
export class LLMAgent {
  constructor(private config: LLMConfig) { }

  private isCerebrasBaseURL(baseURL: string): boolean {
    const normalized = baseURL.toLowerCase()
    return normalized.includes('cerebras.ai') || normalized.includes('cerebras.com')
  }

  private createLinkedAbortController(parentSignal?: AbortSignal): {
    controller: AbortController
    dispose: () => void
  } {
    const controller = new AbortController()
    if (!parentSignal) {
      return {
        controller,
        dispose: () => {},
      }
    }

    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason)
      return {
        controller,
        dispose: () => {},
      }
    }

    const onAbort = () => {
      controller.abort(parentSignal.reason)
    }
    parentSignal.addEventListener('abort', onAbort, { once: true })
    return {
      controller,
      dispose: () => parentSignal.removeEventListener('abort', onAbort),
    }
  }

  /**
   * Call LLM with the given messages
   */
  async callLLM(options: LLMCallOptions): Promise<LLMResult> {
    const shouldSendReasoning = !this.isCerebrasBaseURL(this.config.baseURL)
    const effort = options.reasoningEffort ?? this.config.reasoningEffort
    const { controller, dispose } = this.createLinkedAbortController(options.abortSignal)
    const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : null
    const timeoutError = timeoutMs
      ? Object.assign(new Error(`LLM provider call timeout after ${timeoutMs}ms`), { name: 'TimeoutError' })
      : null
    const timeoutHandle = timeoutMs
      ? setTimeout(() => {
          if (!controller.signal.aborted)
            controller.abort(timeoutError)
        }, timeoutMs)
      : undefined

    try {
      const response = await generateText({
        baseURL: this.config.baseURL,
        apiKey: this.config.apiKey,
        model: this.config.model,
        messages: options.messages,
        headers: { 'Accept-Encoding': 'identity' },
        abortSignal: controller.signal,
        ...(options.responseFormat && { responseFormat: options.responseFormat }),
        // NOTICE:
        // The key must be `reasoningEffort`, not `reasoning`.
        //
        // xsai serialises whatever it is handed (`objCamelToSnake(clean(...))` in
        // @xsai/shared `requestBody`), so the previous `reasoning: { effort: 'low' }`
        // went out as a `reasoning` object that OpenAI-compatible providers do not
        // recognise. Verified against DeepSeek on 2026-08-13: with that shape a
        // capped 300-token reply spent all 300 on thinking, while
        // `reasoning_effort: 'none'` dropped `reasoning_tokens` from the response
        // entirely. Effort was never actually being controlled.
        ...(shouldSendReasoning && effort && { reasoningEffort: effort }),
      } as Parameters<typeof generateText>[0])

      return {
        text: response.text ?? '',
        reasoning: (response as any).reasoningText,
        usage: response.usage,
      }
    }
    finally {
      if (timeoutHandle)
        clearTimeout(timeoutHandle)
      dispose()
    }
  }
}
