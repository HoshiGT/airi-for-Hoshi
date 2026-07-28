import type { StagePointerInputs } from './stage-pointer'

import { describe, expect, it } from 'vitest'

import { resolveStagePointerBehavior } from './stage-pointer'

function inputs(overrides: Partial<StagePointerInputs> = {}): StagePointerInputs {
  return {
    stagePaused: false,
    hearingDialogOpen: false,
    insideControls: false,
    nearBorder: false,
    fadeOnHoverEnabled: true,
    clickThroughAvailable: true,
    isOutsideWindow: false,
    // Cursor near the character (radius sample hits it, so the stage fades) but not on a visible
    // pixel — the case where click-through is both wanted and safe.
    isTransparent: false,
    isTransparentForMouseEvents: true,
    ...overrides,
  }
}

describe('resolveStagePointerBehavior', () => {
  it('stays interactive while the stage is paused', () => {
    const behavior = resolveStagePointerBehavior(inputs({ stagePaused: true }))

    expect(behavior.ignoreMouseEvents).toBe(false)
    expect(behavior.fadeOnCursorWithin).toBe(false)
    expect(behavior.trackCursorTransparency).toBe(false)
  })

  it('stays interactive while the hearing dialog is open', () => {
    const behavior = resolveStagePointerBehavior(inputs({ hearingDialogOpen: true }))

    expect(behavior.ignoreMouseEvents).toBe(false)
    expect(behavior.trackCursorTransparency).toBe(false)
  })

  it('stays interactive while the cursor is inside the controls island', () => {
    const behavior = resolveStagePointerBehavior(inputs({ insideControls: true }))

    expect(behavior.ignoreMouseEvents).toBe(false)
  })

  it('stays interactive near the window border so resizing keeps working', () => {
    const behavior = resolveStagePointerBehavior(inputs({ nearBorder: true }))

    expect(behavior.ignoreMouseEvents).toBe(false)
  })

  it('engages click-through with fade enabled where the platform supports it', () => {
    const behavior = resolveStagePointerBehavior(inputs())

    expect(behavior.ignoreMouseEvents).toBe(true)
    expect(behavior.fadeOnCursorWithin).toBe(true)
    expect(behavior.trackCursorTransparency).toBe(true)
  })

  it('keeps the window interactive while the cursor is on a visible model pixel', () => {
    const behavior = resolveStagePointerBehavior(inputs({ isTransparentForMouseEvents: false }))

    expect(behavior.ignoreMouseEvents).toBe(false)
    expect(behavior.fadeOnCursorWithin).toBe(true)
    expect(behavior.trackCursorTransparency).toBe(true)
  })

  // ROOT CAUSE:
  //
  // On Linux, screen.getCursorScreenPoint() only updates from events delivered
  // to the app's own windows (proven with a standalone Electron probe on
  // X11). Before the patch, enabling fade-on-hover called
  // setIgnoreMouseEvents(true) unconditionally; the click-through window then
  // stopped producing pointer events, the tracked cursor position froze, and
  // the "cursor inside controls island" escape branch could never fire again —
  // the window stayed unclickable across restarts because the preference is
  // persisted (user report, in-session, 2026-07-04: "点不了里面的任何东西...
  // 永远关不掉...除非重新安装").
  //
  // Fixed by keeping fade-on-hover purely visual when click-through is
  // unavailable: fade and transparency tracking stay active, but the window
  // keeps receiving mouse events.
  it('never engages click-through when the platform cannot track the cursor globally (Linux)', () => {
    const behavior = resolveStagePointerBehavior(inputs({ clickThroughAvailable: false }))

    expect(behavior.ignoreMouseEvents).toBe(false)
    expect(behavior.fadeOnCursorWithin).toBe(true)
    expect(behavior.trackCursorTransparency).toBe(true)
  })

  it('does not fade while the cursor is outside the window', () => {
    const behavior = resolveStagePointerBehavior(inputs({ isOutsideWindow: true }))

    expect(behavior.fadeOnCursorWithin).toBe(false)
    expect(behavior.trackCursorTransparency).toBe(true)
  })

  it('does not fade while the cursor is over a transparent stage region', () => {
    const behavior = resolveStagePointerBehavior(inputs({ isTransparent: true }))

    expect(behavior.fadeOnCursorWithin).toBe(false)
  })

  it('keeps everything off while fade-on-hover is disabled', () => {
    const behavior = resolveStagePointerBehavior(inputs({ fadeOnHoverEnabled: false }))

    expect(behavior.ignoreMouseEvents).toBe(false)
    expect(behavior.fadeOnCursorWithin).toBe(false)
    expect(behavior.trackCursorTransparency).toBe(false)
  })
})
