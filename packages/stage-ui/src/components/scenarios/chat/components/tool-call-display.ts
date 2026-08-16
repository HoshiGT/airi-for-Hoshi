interface ContentPartLike { type: string, text?: string }

function isContentPartArray(value: unknown): value is ContentPartLike[] {
  return Array.isArray(value)
    && value.every(item => typeof item === 'object' && item !== null && typeof (item as { type?: unknown }).type === 'string')
}

/**
 * Collapses one content part to compact text. Binary parts (a screenshot from
 * desktop_look, audio, a file) become a short marker so the UI never renders a
 * multi-hundred-KB base64 data URL inline.
 */
function contentPartToText(part: ContentPartLike): string {
  switch (part.type) {
    case 'text':
      return part.text ?? ''
    case 'image_url':
      return '[image]'
    case 'input_audio':
      return '[audio]'
    case 'file':
      return '[file]'
    default:
      return `[${part.type}]`
  }
}

/**
 * Normalizes a tool result into readable text for compact chat UI.
 *
 * Before:
 * - { ok: true, mode: "focus" }
 * - [{ type: "text", text: "screen:" }, { type: "image_url", image_url: {...} }]
 * - "Tool call error for \"play_chess\": failed"
 *
 * After:
 * - "{\n  \"ok\": true,\n  \"mode\": \"focus\"\n}"
 * - "screen:\n[image]"
 * - "Tool call error for \"play_chess\": failed"
 */
export function normalizeToolResultText(result: unknown): string {
  if (result == null) {
    return ''
  }

  if (typeof result === 'string') {
    return result.trim()
  }

  // Tool results may be a content-part array (e.g. desktop_look returns a text
  // hint plus the screenshot as an image block); render the text and mark the
  // binary parts instead of stringifying the whole base64 payload.
  if (isContentPartArray(result)) {
    return result.map(contentPartToText).join('\n').trim()
  }

  try {
    return JSON.stringify(result, null, 2).trim()
  }
  catch {
    return String(result).trim()
  }
}

/**
 * Creates a displayable `Error` from a failed tool result.
 *
 * Use when:
 * - A tool call block needs to reuse the shared copyable error panel
 *
 * Expects:
 * - Tool failures may arrive as strings or structured values
 *
 * Returns:
 * - `Error` when there is readable text, otherwise `undefined`
 */
export function createToolResultError(result: unknown): Error | undefined {
  const message = normalizeToolResultText(result)
  if (!message) {
    return undefined
  }

  return new Error(message)
}
