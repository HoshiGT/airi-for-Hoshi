/**
 * Decides how the stage window treats the OS pointer for the fade-on-hover
 * feature: whether to engage OS-level click-through, whether the stage should
 * visually fade right now, and whether cursor-transparency tracking needs to
 * run at all.
 *
 * Kept pure so the platform-safety rule below is unit-testable.
 */
export interface StagePointerInputs {
  stagePaused: boolean
  hearingDialogOpen: boolean
  /** Cursor is inside the controls island or the status island (debounced). */
  insideControls: boolean
  /** Cursor is near the window border (debounced), where resizing must stay possible. */
  nearBorder: boolean
  fadeOnHoverEnabled: boolean
  /**
   * Whether OS-level click-through is safe on this platform. See the NOTICE in
   * {@link resolveStagePointerBehavior} — must be `false` on Linux.
   */
  clickThroughAvailable: boolean
  isOutsideWindow: boolean
  /**
   * The stage render is transparent at the cursor position, sampled with a radius so the value
   * stays stable near the character's edges. Drives fading only — too fuzzy to decide clicks.
   */
  isTransparent: boolean
  /**
   * The stage render is transparent at exactly the cursor pixel. Only this may pass a click
   * through, so visible model pixels stay interactive while fade-on-hover is on.
   */
  isTransparentForMouseEvents: boolean
}

export interface StagePointerBehavior {
  /** Value to pass to `setIgnoreMouseEvents`. */
  ignoreMouseEvents: boolean
  /** The stage should be faded out right now (cursor is over the character). */
  fadeOnCursorWithin: boolean
  /** Keep the cursor-transparency watcher running (fade tracking active). */
  trackCursorTransparency: boolean
}

// NOTICE:
// On Linux, Chromium only learns the global cursor position from events
// delivered to this app's own windows, so `screen.getCursorScreenPoint()`
// freezes whenever the cursor is over another app's surface (verified
// empirically with a standalone Electron probe on X11, 2026-07-04; Wayland
// never exposes a global cursor at all). Once `setIgnoreMouseEvents(true)` is
// engaged the stage window stops producing pointer events itself, so the
// tracked position freezes permanently and the "cursor inside controls island"
// escape condition can never fire again — the window becomes unclickable until
// the persisted preference is wiped. The `forward: true` option that keeps
// tracking alive during click-through is Windows/macOS-only.
//
// Therefore on Linux (`clickThroughAvailable: false`) fade-on-hover is purely
// visual: the character still fades under the cursor, but the window keeps
// receiving mouse events (which is exactly what keeps the tracking loop fed).
export function resolveStagePointerBehavior(inputs: StagePointerInputs): StagePointerBehavior {
  const interactive: StagePointerBehavior = {
    ignoreMouseEvents: false,
    fadeOnCursorWithin: false,
    trackCursorTransparency: false,
  }

  if (inputs.stagePaused)
    return interactive

  // Hearing dialog/drawer is open; keep window interactive
  if (inputs.hearingDialogOpen)
    return interactive

  // Inside interactive controls or near resize border: do NOT ignore events
  if (inputs.insideControls || inputs.nearBorder)
    return interactive

  return {
    ignoreMouseEvents: inputs.fadeOnHoverEnabled && inputs.clickThroughAvailable && inputs.isTransparentForMouseEvents,
    fadeOnCursorWithin: inputs.fadeOnHoverEnabled && !inputs.isOutsideWindow && !inputs.isTransparent,
    trackCursorTransparency: inputs.fadeOnHoverEnabled,
  }
}
