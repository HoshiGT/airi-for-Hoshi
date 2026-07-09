import type { DesktopKeyboardAction, DesktopMouseAction } from '../../../shared/eventa'

/**
 * Pure builders that turn a desktop-control action into `xdotool` argv.
 *
 * Kept free of any Electron/Node runtime imports so the argument shaping can be
 * unit-tested directly. The owning service ({@link file://./desktop-control.ts})
 * spawns `xdotool` with whatever these return.
 */

// X11 physical button codes used by `xdotool click`.
const MOUSE_BUTTON_CODES: Record<NonNullable<DesktopMouseAction['button']>, number> = {
  left: 1,
  middle: 2,
  right: 3,
}

// `xdotool` models the scroll wheel as button clicks: 4 is a wheel-up notch and
// 5 is a wheel-down notch. We repeat the click once per requested step.
const SCROLL_BUTTON_UP = 4
const SCROLL_BUTTON_DOWN = 5

// Guards against a runaway model asking to scroll thousands of notches at once.
const MAX_SCROLL_STEPS = 50

function movePrefix(action: DesktopMouseAction): string[] {
  const hasPoint = Number.isFinite(action.x) && Number.isFinite(action.y)
  if (!hasPoint)
    return []

  return ['mousemove', String(Math.round(action.x!)), String(Math.round(action.y!))]
}

/**
 * Builds the `xdotool` argv for one pointer action.
 *
 * Coordinates are absolute device pixels; the renderer maps the model's
 * in-image coordinates onto the screen before dispatching, so callers here can
 * assume `x`/`y` are already screen-space. When present, the pointer is moved
 * first and the button action is chained in the same invocation.
 *
 * @throws when a `move` action omits coordinates.
 */
export function buildMouseArgs(action: DesktopMouseAction): string[] {
  const move = movePrefix(action)
  const button = MOUSE_BUTTON_CODES[action.button ?? 'left']

  switch (action.action) {
    case 'move':
      if (move.length === 0)
        throw new Error('mouse move requires numeric x and y')
      return move
    case 'click':
      return [...move, 'click', String(button)]
    case 'double_click':
      return [...move, 'click', '--repeat', '2', '--delay', '120', String(button)]
    case 'scroll': {
      const requested = action.scrollAmount ?? 3
      const steps = Math.min(MAX_SCROLL_STEPS, Math.max(1, Math.abs(Math.round(requested))))
      // Negative amount scrolls up, matching a natural "scrollAmount as delta-y".
      const wheel = requested < 0 ? SCROLL_BUTTON_UP : SCROLL_BUTTON_DOWN
      return [...move, 'click', '--repeat', String(steps), String(wheel)]
    }
    default:
      throw new Error(`unsupported mouse action: ${(action as DesktopMouseAction).action}`)
  }
}

/**
 * Builds the `xdotool` argv for one keyboard action.
 *
 * `type` sends literal UTF-8 text; `key` presses one or more chords such as
 * `ctrl+c` or `alt+Tab` (X keysym syntax). `--` terminates option parsing so
 * text or keys that begin with `-` are never mistaken for flags.
 *
 * @throws when the action carries no text/keys to send.
 */
export function buildKeyboardArgs(action: DesktopKeyboardAction): string[] {
  switch (action.action) {
    case 'type': {
      const text = action.text ?? ''
      if (!text)
        throw new Error('keyboard type requires non-empty text')
      return ['type', '--clearmodifiers', '--', text]
    }
    case 'key': {
      const keys = (action.keys ?? '').trim()
      if (!keys)
        throw new Error('keyboard key requires a non-empty chord')
      // xdotool accepts several space-separated chords in one `key` invocation.
      return ['key', '--clearmodifiers', '--', ...keys.split(/\s+/)]
    }
    default:
      throw new Error(`unsupported keyboard action: ${(action as DesktopKeyboardAction).action}`)
  }
}
