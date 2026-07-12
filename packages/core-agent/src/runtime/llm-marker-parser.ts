const TAG_OPEN = '<|'
const TAG_CLOSE = '|>'
const ESCAPED_TAG_OPEN = '<{\'|\'}'
const ESCAPED_TAG_CLOSE = '{\'|\'}>'

// NOTICE:
// The stage system prompt instructs "Start every reply with an ACT token".
// Weaker models recite that instruction literally and prefix replies with
// plain text such as `ACT token: \n` or `ACT token: {"emotion":"happy"}`
// instead of (or in addition to) the marker-shaped `<|ACT {...}|>`. That
// recital is not wrapped in `<|`/`|>`, so without special handling it leaks
// into the visible and spoken reply.
// We swallow the recital at the stream head only, and when a bare JSON
// payload follows it we re-emit it as a proper `<|ACT {...}|>` special so the
// emotion still reaches the stage.
// Removal condition: all supported models reliably emit well-formed markers.
const RECITAL_WORD = 'act token'

// Recited payloads are short emotion/motion objects; if a brace runs longer
// than this without closing, it is not a payload we should keep withholding
// stream output for.
const RECITAL_PAYLOAD_MAX_LENGTH = 300

interface RecitalResolution {
  /** True while there is not enough input to decide; caller must wait. */
  pending: boolean
  /** Buffer with the recital (if any) removed. */
  rest: string
  /** Proper `<|ACT {...}|>` special recovered from a recited JSON payload. */
  special?: string
}

/**
 * Scans for a balanced JSON object literal at the start of `text`, tracking
 * strings/escapes so braces inside string values do not end the scan early.
 */
function scanJsonObject(text: string): { complete: boolean, length: number } {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped)
        escaped = false
      else if (char === '\\')
        escaped = true
      else if (char === '"')
        inString = false
      continue
    }
    if (char === '"') {
      inString = true
    }
    else if (char === '{') {
      depth++
    }
    else if (char === '}') {
      depth--
      if (depth === 0)
        return { complete: true, length: i + 1 }
    }
  }

  return { complete: false, length: text.length }
}

/**
 * Decides whether the very beginning of the model output is a recited
 * `ACT token:` instruction and where the real reply starts.
 *
 * Returns `pending` while the buffered head is still an ambiguous prefix of
 * the recital (e.g. `ACT tok` mid-chunk) and the stream has not ended, so the
 * caller withholds emission instead of leaking a partial recital.
 */
function resolveRecitedActHead(buffer: string, streamEnded: boolean): RecitalResolution {
  const leadingWhitespaceLength = buffer.match(/^\s*/)![0].length
  const lowered = buffer.slice(leadingWhitespaceLength).toLowerCase()

  if (lowered.length < RECITAL_WORD.length) {
    const pending = !streamEnded && RECITAL_WORD.startsWith(lowered)
    return { pending, rest: buffer }
  }

  if (!lowered.startsWith(RECITAL_WORD))
    return { pending: false, rest: buffer }

  const afterWordIndex = leadingWhitespaceLength + RECITAL_WORD.length
  const afterWord = buffer.slice(afterWordIndex)

  // A letter/digit right after means a longer word ("ACT tokens are..."),
  // which is genuine reply text, not a recital.
  if (!afterWord && !streamEnded)
    return { pending: true, rest: buffer }
  if (/^[a-z0-9]/i.test(afterWord))
    return { pending: false, rest: buffer }

  // Consume the optional (full-width tolerated) colon plus surrounding
  // whitespace, then wait until we can see whether a payload follows.
  const separatorLength = afterWord.match(/^\s*[:：]?\s*/)![0].length
  const afterSeparator = buffer.slice(afterWordIndex + separatorLength)
  if (!afterSeparator) {
    if (!streamEnded)
      return { pending: true, rest: buffer }
    // The whole reply was just the recital; nothing real to emit.
    return { pending: false, rest: '' }
  }

  if (afterSeparator.startsWith('{')) {
    const scan = scanJsonObject(afterSeparator)
    if (!scan.complete) {
      if (!streamEnded && afterSeparator.length <= RECITAL_PAYLOAD_MAX_LENGTH)
        return { pending: true, rest: buffer }
      // Unclosed or oversized brace: drop only the recital words and let the
      // remainder flow through as ordinary text.
      return { pending: false, rest: afterSeparator }
    }

    const payloadText = afterSeparator.slice(0, scan.length)
    try {
      const payload: unknown = JSON.parse(payloadText)
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const afterPayload = afterSeparator.slice(scan.length)
        // Wait for the character after the payload so a line break that
        // arrives in the next chunk can still be swallowed below.
        if (!afterPayload && !streamEnded)
          return { pending: true, rest: buffer }
        // Swallow one trailing line break so the reply does not start blank.
        const rest = afterPayload.replace(/^[ \t]*\n?/, '')
        return { pending: false, rest, special: `${TAG_OPEN}ACT ${payloadText}${TAG_CLOSE}` }
      }
    }
    catch {
      // Malformed payload: fall through and keep it as visible text so we do
      // not silently destroy reply content we cannot interpret.
    }
    return { pending: false, rest: afterSeparator }
  }

  return { pending: false, rest: afterSeparator }
}

interface MarkerToken {
  type: 'literal' | 'special'
  value: string
}

interface MarkerParserOptions {
  minLiteralEmitLength?: number
}

interface StreamController<T> {
  stream: ReadableStream<T>
  write: (value: T) => void
  close: () => void
  error: (err: unknown) => void
}

function createPushStream<T>(): StreamController<T> {
  let closed = false
  let controller: ReadableStreamDefaultController<T> | null = null

  const stream = new ReadableStream<T>({
    start(ctrl) {
      controller = ctrl
    },
    cancel() {
      closed = true
    },
  })

  return {
    stream,
    write(value) {
      if (!controller || closed)
        return
      controller.enqueue(value)
    },
    close() {
      if (!controller || closed)
        return
      closed = true
      controller.close()
    },
    error(err) {
      if (!controller || closed)
        return
      closed = true
      controller.error(err)
    },
  }
}

async function readStream<T>(stream: ReadableStream<T>, handler: (value: T) => Promise<void> | void) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done)
        break
      await handler(value as T)
    }
  }
  finally {
    reader.releaseLock()
  }
}

function createLlmMarkerParser(options?: MarkerParserOptions) {
  const minLiteralEmitLength = Math.max(1, options?.minLiteralEmitLength ?? 1)
  const tailLength = Math.max(TAG_OPEN.length - 1, ESCAPED_TAG_OPEN.length - 1)
  let buffer = ''
  let inTag = false
  let headResolved = false

  return {
    async consume(textPart: string, onLiteral: (value: string) => Promise<void> | void, onSpecial: (value: string) => Promise<void> | void) {
      buffer += textPart
      buffer = buffer
        .replaceAll(ESCAPED_TAG_OPEN, TAG_OPEN)
        .replaceAll(ESCAPED_TAG_CLOSE, TAG_CLOSE)

      if (!headResolved) {
        const resolution = resolveRecitedActHead(buffer, false)
        if (resolution.pending)
          return
        headResolved = true
        buffer = resolution.rest
        if (resolution.special)
          await onSpecial(resolution.special)
      }

      while (buffer.length > 0) {
        if (!inTag) {
          const openTagIndex = buffer.indexOf(TAG_OPEN)
          if (openTagIndex < 0) {
            if (buffer.length - tailLength >= minLiteralEmitLength) {
              const emit = buffer.slice(0, -tailLength)
              buffer = buffer.slice(-tailLength)
              await onLiteral(emit)
            }
            break
          }

          if (openTagIndex > 0) {
            const emit = buffer.slice(0, openTagIndex)
            buffer = buffer.slice(openTagIndex)
            await onLiteral(emit)
          }
          inTag = true
        }
        else {
          const closeTagIndex = buffer.indexOf(TAG_CLOSE)
          if (closeTagIndex < 0)
            break

          const emit = buffer.slice(0, closeTagIndex + TAG_CLOSE.length)
          buffer = buffer.slice(closeTagIndex + TAG_CLOSE.length)
          await onSpecial(emit)
          inTag = false
        }
      }
    },

    async end(onLiteral: (value: string) => Promise<void> | void, onSpecial?: (value: string) => Promise<void> | void) {
      if (!headResolved) {
        // With the stream ended the head can always be resolved (never pending).
        const resolution = resolveRecitedActHead(buffer, true)
        headResolved = true
        buffer = resolution.rest
        if (resolution.special)
          await onSpecial?.(resolution.special)
      }
      if (!inTag && buffer.length > 0) {
        await onLiteral(buffer)
        buffer = ''
      }
    },
  }
}

function createLlmMarkerStream(input: ReadableStream<string>, options?: MarkerParserOptions) {
  const { stream, write, close, error } = createPushStream<MarkerToken>()
  const parser = createLlmMarkerParser(options)

  void readStream(input, async (chunk) => {
    await parser.consume(
      chunk,
      async (literal) => {
        if (!literal)
          return
        write({ type: 'literal', value: literal })
      },
      async (special) => {
        write({ type: 'special', value: special })
      },
    )
  })
    .then(async () => {
      await parser.end(
        async (literal) => {
          if (!literal)
            return
          write({ type: 'literal', value: literal })
        },
        async (special) => {
          write({ type: 'special', value: special })
        },
      )
      close()
    })
    .catch((err) => {
      error(err)
    })

  return stream
}

/**
 * Creates a streaming parser for LLM responses with AIRI special markers.
 *
 * Use when:
 * - Handling streamed model output that may contain `<|...|>` markers.
 * - Literal text and special marker tokens need to be emitted separately.
 *
 * Expects:
 * - Callers feed chunks in order and call `end()` once the model stream ends.
 *
 * Returns:
 * - A parser with `consume()` and `end()` methods.
 */
export function useLlmmarkerParser(options: {
  onLiteral?: (literal: string) => void | Promise<void>
  onSpecial?: (special: string) => void | Promise<void>
  /**
   * Called when parsing ends with the full accumulated text.
   * Useful for final processing like categorization or filtering.
   */
  onEnd?: (fullText: string) => void | Promise<void>
  /**
   * The minimum length of text required to emit a literal part.
   * Useful for avoiding emitting literal parts too fast.
   */
  minLiteralEmitLength?: number
}) {
  let fullText = ''
  const { stream, write, close } = createPushStream<string>()

  const markerStream = createLlmMarkerStream(stream, { minLiteralEmitLength: options.minLiteralEmitLength })

  const processing = readStream(markerStream, async (token) => {
    if (token.type === 'literal')
      await options.onLiteral?.(token.value)
    if (token.type === 'special')
      await options.onSpecial?.(token.value)
  })

  return {
    /**
     * Consumes a chunk of text from the stream.
     *
     * @param textPart The chunk of text to consume.
     */
    async consume(textPart: string) {
      fullText += textPart
      write(textPart)
    },

    /**
     * Finalizes the parsing process.
     * Any remaining content in the buffer is flushed as a final literal part.
     */
    async end() {
      close()
      await processing
      await options.onEnd?.(fullText)
    },
  }
}
