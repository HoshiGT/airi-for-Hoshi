/**
 * The sticker marker contract shared by both ends of the pipeline:
 *
 * - Prompt side (stage-ui sticker store) tells the model it may emit
 *   `<|STICKER_名字|>` inline, listing the available sticker names.
 * - Stream side (chat orchestrator runtime) recognizes the marker among the
 *   parsed `<|...|>` specials and turns it into a persisted `sticker` slice.
 *
 * Keeping format + parse in one module means the prefix can never drift
 * between the prompt the model reads and the parser that decodes its output.
 */

const STICKER_MARKER_PREFIX = '<|STICKER_'
const STICKER_MARKER_SUFFIX = '|>'

/** Renders the marker the model must emit to send the named sticker. */
export function formatStickerMarker(name: string): string {
  return `${STICKER_MARKER_PREFIX}${name}${STICKER_MARKER_SUFFIX}`
}

/**
 * Extracts the sticker name from a parsed special token, or `undefined` when
 * the special is some other marker (EMOTE, ACT, ...). Names are free-form
 * (Chinese, spaces, emoji all allowed) — the marker parser already guarantees
 * the token is a complete `<|...|>` unit, so everything between the prefix and
 * the closing tag is the name.
 */
export function parseStickerMarker(special: string): string | undefined {
  if (!special.startsWith(STICKER_MARKER_PREFIX) || !special.endsWith(STICKER_MARKER_SUFFIX))
    return undefined

  const name = special.slice(STICKER_MARKER_PREFIX.length, -STICKER_MARKER_SUFFIX.length).trim()
  return name || undefined
}
