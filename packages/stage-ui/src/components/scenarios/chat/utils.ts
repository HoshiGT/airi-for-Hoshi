import type { ChatHistoryItem } from '../../../types/chat'

function isTextPart(part: unknown): part is { type: 'text', text?: string } {
  return typeof part === 'object'
    && part !== null
    && 'type' in part
    && part.type === 'text'
    && 'text' in part
}

function getTextFromContentParts(parts: unknown[]): string {
  return parts.reduce<string[]>((texts, part) => {
    if (!isTextPart(part))
      return texts

    const text = part.text?.trim()
    if (text)
      texts.push(text)

    return texts
  }, []).join('\n\n')
}

export function getChatHistoryItemCopyText(message: ChatHistoryItem): string {
  if (message.role === 'error')
    return message.content

  if (message.role === 'assistant') {
    if (message.slices?.length) {
      const text = message.slices
        .filter(slice => slice.type === 'text')
        .map(slice => slice.text.trim())
        .filter(Boolean)
        .join('\n\n')

      if (text)
        return text
    }

    if (typeof message.content === 'string')
      return message.content

    if (Array.isArray(message.content)) {
      const text = getTextFromContentParts(message.content)

      if (text)
        return text

      return message.content.map(entry => JSON.stringify(entry)).join('\n')
    }

    return ''
  }

  if (typeof message.content === 'string')
    return message.content

  if (Array.isArray(message.content)) {
    const text = getTextFromContentParts(message.content)

    if (text)
      return text

    return message.content.map(entry => JSON.stringify(entry)).join('\n')
  }

  return ''
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Normalizes a message timestamp into the compact form chat apps use for
 * everyday display, shortest for the most recent:
 *
 * Before (createdAt, relative to `now`):
 * - same day      -> "14:32"
 * - yesterday     -> "昨天 14:32" (label supplied by the caller's i18n)
 * - same year     -> "04-25 14:32"
 * - earlier years -> "2025-04-25 14:32"
 *
 * Returns an empty string when the message predates timestamp recording
 * (no `createdAt`), so callers can simply hide the element.
 */
export function formatChatTimestamp(
  createdAt: number | undefined,
  labels: { yesterday: string },
  now: number = Date.now(),
): string {
  if (createdAt == null)
    return ''

  const date = new Date(createdAt)
  const nowDate = new Date(now)
  const time = `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`

  // Compare calendar days in local time, not raw 24h windows, so 23:59
  // yesterday still reads as yesterday at 00:01 today.
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(nowDate) - startOfDay(date)) / 86_400_000)

  if (dayDiff === 0)
    return time
  if (dayDiff === 1)
    return `${labels.yesterday} ${time}`

  const monthDay = `${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`
  if (date.getFullYear() === nowDate.getFullYear())
    return `${monthDay} ${time}`
  return `${date.getFullYear()}-${monthDay} ${time}`
}

export function getChatHistoryItemKey(message: ChatHistoryItem | undefined, index: number): string | number {
  if (!message)
    return index

  if (message.id)
    return message.id

  if (message.createdAt != null)
    return `${message.role}:${message.createdAt}:${index}`

  return `${message.role}:${index}`
}
