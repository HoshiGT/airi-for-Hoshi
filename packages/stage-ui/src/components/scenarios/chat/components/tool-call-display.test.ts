import { describe, expect, it } from 'vitest'

import { createToolResultError, normalizeToolResultText } from './tool-call-display'

describe('tool call display helpers', () => {
  /**
   * @example
   * expect(normalizeToolResultText({ ok: true })).toContain('"ok": true')
   */
  it('normalizes structured tool results into copyable text', () => {
    const text = normalizeToolResultText({
      ok: true,
      mode: 'focus',
    })

    expect(text).toContain('"ok": true')
    expect(text).toContain('"mode": "focus"')
  })

  it('renders a content-part array as text plus a marker instead of a base64 blob', () => {
    const text = normalizeToolResultText([
      { type: 'text', text: 'This is a screenshot of the user\'s screen.' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAABBBBCCCC' } },
    ])

    expect(text).toBe('This is a screenshot of the user\'s screen.\n[image]')
    expect(text).not.toContain('base64')
  })

  /**
   * @example
   * expect(createToolResultError('Tool failed')?.message).toBe('Tool failed')
   */
  it('creates an Error wrapper for failed tool results', () => {
    const error = createToolResultError('Tool call error for "play_chess": Focus mode does not accept game-state mutation inputs.')

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain('Focus mode does not accept game-state mutation inputs.')
  })
})
