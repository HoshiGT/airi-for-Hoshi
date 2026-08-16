import type { DesktopScreenshotGeometry } from '@proj-airi/stage-ui/stores/modules/desktop-control'
import type { ImageContentPart, TextContentPart, Tool } from '@xsai/shared-chat'

import type {
  DesktopKeyboardAction,
  DesktopMouseAction,
  DesktopScreenshot,
  DesktopScreenshotRequest,
} from '../../../../shared/eventa'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { mapImagePointToScreen, useDesktopControlStore } from '@proj-airi/stage-ui/stores/modules/desktop-control'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import {
  desktopControlKeyboard,
  desktopControlMouse,
  desktopControlScreenshot,
} from '../../../../shared/eventa'

/**
 * Neuro-style desktop-control tools: let the character look at the real screen
 * (a one-shot screenshot handed straight to the chat model) and drive the mouse
 * and keyboard. Registered into the shared LLM tools store only while the
 * desktop-control module is enabled (see `stores/desktop-control-tools.ts`), so
 * these executes treat the store flags as a defense-in-depth re-check rather
 * than the primary gate.
 *
 * `desktop_look` returns the frame as an image content block rather than routing
 * it through a separate vision model: the chat brain sees images natively, so a
 * middleman OCR/describe call would only burn tokens on another provider. This
 * assumes the active chat model is vision-capable (the intended Claude brain).
 */

export interface DesktopControlInvokers {
  screenshot: (request: DesktopScreenshotRequest) => Promise<DesktopScreenshot>
  mouse: (action: DesktopMouseAction) => Promise<void>
  keyboard: (action: DesktopKeyboardAction) => Promise<void>
}

/** Minimal store surface the tools touch; injected in tests. */
export interface DesktopControlStoreLike {
  enabled: boolean
  canControlMouse: boolean
  canControlKeyboard: boolean
  lastScreenshot: DesktopScreenshotGeometry | null
  setLastScreenshot: (geometry: DesktopScreenshotGeometry | null) => void
}

/** Text instruction plus the captured frame, handed to the chat model as-is. */
export type DesktopLookResult = [TextContentPart, ImageContentPart]

export interface DesktopControlToolDeps {
  invokers?: DesktopControlInvokers
  store?: DesktopControlStoreLike
}

let cachedInvokers: DesktopControlInvokers | undefined

function createInvokers(): DesktopControlInvokers {
  const { context } = createContext(window.electron.ipcRenderer)

  return {
    screenshot: defineInvoke(context, desktopControlScreenshot),
    mouse: defineInvoke(context, desktopControlMouse),
    keyboard: defineInvoke(context, desktopControlKeyboard),
  }
}

function resolveInvokers(override?: DesktopControlInvokers): DesktopControlInvokers {
  if (override)
    return override
  if (!cachedInvokers)
    cachedInvokers = createInvokers()
  return cachedInvokers
}

function resolveStore(override?: DesktopControlStoreLike): DesktopControlStoreLike {
  if (override)
    return override

  const store = useDesktopControlStore()
  return {
    get enabled() { return store.enabled },
    get canControlMouse() { return store.canControlMouse },
    get canControlKeyboard() { return store.canControlKeyboard },
    get lastScreenshot() { return store.lastScreenshot },
    setLastScreenshot: geometry => store.setLastScreenshot(geometry),
  }
}

// Instruction text that rides alongside the screenshot image block. It addresses
// the chat model directly (which now sees the frame itself) rather than a
// separate vision model. `${w}x${h}` is the screenshot's pixel space, which is
// also the coordinate space desktop_mouse expects, so stating it lets the model
// give click coordinates the mouse tool can map back to the physical screen.
const LOOK_PROMPTS = {
  describe: 'This is a screenshot of the user\'s screen right now. Use what you see in it to answer.',
  read_text: 'This is a screenshot of the user\'s screen right now. Read the visible text from it.',
} as const

function buildLocatePrompt(target: string, image: DesktopScreenshot): string {
  return [
    `This is a ${image.width}x${image.height} screenshot of the user's screen (top-left is the origin).`,
    `Find the UI element described as: "${target}".`,
    'To act on it, call desktop_mouse with the element\'s center as pixel coordinates in THIS screenshot; otherwise just tell the user where it is. Do not invent coordinates if it is not visible.',
  ].join('\n')
}

const desktopLookParams = z.object({
  mode: z.enum(['describe', 'read_text', 'locate']).describe('describe = summarize the screen; read_text = OCR the visible text; locate = find one element and return its pixel coordinates'),
  target: z.string().describe('Only used when mode is "locate": a short description of the element to find, e.g. "the Send button". Pass an empty string otherwise.'),
})

const desktopMouseParams = z.object({
  action: z.enum(['move', 'click', 'double_click', 'scroll']).describe('move = move pointer only; click / double_click = at (x,y); scroll = wheel at (x,y)'),
  x: z.number().describe('X coordinate in the pixel space of the most recent desktop_look screenshot (top-left origin)'),
  y: z.number().describe('Y coordinate in the pixel space of the most recent desktop_look screenshot (top-left origin)'),
  button: z.enum(['left', 'right', 'middle']).describe('Mouse button for click actions; use "left" unless a context menu is needed'),
  scrollAmount: z.number().describe('Wheel steps for scroll; positive scrolls down, negative scrolls up. Ignored by other actions.'),
})

const desktopKeyboardParams = z.object({
  action: z.enum(['type', 'key']).describe('type = send literal text; key = press a chord such as ctrl+c or Return'),
  text: z.string().describe('Literal text to type when action is "type". Empty for "key".'),
  keys: z.string().describe('Key chord(s) when action is "key", e.g. "ctrl+c", "Return", "alt+Tab". Empty for "type". Space-separate multiple chords.'),
})

type DesktopLookInput = z.infer<typeof desktopLookParams>
type DesktopMouseInput = z.infer<typeof desktopMouseParams>
type DesktopKeyboardInput = z.infer<typeof desktopKeyboardParams>

export async function executeDesktopLook(input: DesktopLookInput, deps?: DesktopControlToolDeps): Promise<DesktopLookResult> {
  const store = resolveStore(deps?.store)
  if (!store.enabled)
    throw new Error('Desktop control is turned off. Enable it in Settings → Modules → Desktop control.')

  const invokers = resolveInvokers(deps?.invokers)

  const screenshot = await invokers.screenshot({})
  // Retain the frame geometry so a follow-up desktop_mouse call can map the
  // model's in-image coordinates back onto the physical screen.
  store.setLastScreenshot(screenshot)

  const instruction = input.mode === 'locate'
    ? buildLocatePrompt(input.target.trim() || 'the element the user just referred to', screenshot)
    : LOOK_PROMPTS[input.mode]

  // Return text + the frame as a content-part array. xsAI forwards such arrays
  // as the tool-result content verbatim (see @xsai/tool `wrapToolResult`), and
  // the claude-code-brain relay attaches the latest screenshot as a real image
  // block — so the chat model sees the screen directly, no vision middleman.
  return [
    { type: 'text', text: instruction },
    { type: 'image_url', image_url: { url: screenshot.dataUrl } },
  ]
}

export async function executeDesktopMouse(input: DesktopMouseInput, deps?: DesktopControlToolDeps): Promise<string> {
  const store = resolveStore(deps?.store)
  if (!store.canControlMouse)
    throw new Error('Mouse control is unavailable (module off or xdotool not installed).')

  const geometry = store.lastScreenshot
  if (!geometry)
    throw new Error('Take a look at the screen with desktop_look before moving the mouse, so coordinates can be mapped.')

  const screenPoint = mapImagePointToScreen({ x: input.x, y: input.y }, geometry)
  const invokers = resolveInvokers(deps?.invokers)

  await invokers.mouse({
    action: input.action,
    x: screenPoint.x,
    y: screenPoint.y,
    button: input.button,
    scrollAmount: input.scrollAmount,
  })

  const where = `screen (${screenPoint.x}, ${screenPoint.y})`
  switch (input.action) {
    case 'move':
      return `Moved the pointer to ${where}.`
    case 'click':
      return `${input.button} clicked at ${where}.`
    case 'double_click':
      return `Double clicked at ${where}.`
    case 'scroll':
      return `Scrolled ${input.scrollAmount < 0 ? 'up' : 'down'} at ${where}.`
    default:
      return 'No mouse action performed.'
  }
}

export async function executeDesktopKeyboard(input: DesktopKeyboardInput, deps?: DesktopControlToolDeps): Promise<string> {
  const store = resolveStore(deps?.store)
  if (!store.canControlKeyboard)
    throw new Error('Keyboard control is unavailable (module off or xdotool not installed).')

  const invokers = resolveInvokers(deps?.invokers)

  if (input.action === 'type') {
    const text = input.text ?? ''
    if (!text)
      throw new Error('type requires non-empty text.')
    await invokers.keyboard({ action: 'type', text })
    return `Typed ${text.length} character${text.length === 1 ? '' : 's'}.`
  }

  const keys = (input.keys ?? '').trim()
  if (!keys)
    throw new Error('key requires a non-empty chord.')
  await invokers.keyboard({ action: 'key', keys })
  return `Pressed ${keys}.`
}

/** Capabilities to include when building the tool list; mirrors the module flags. */
export interface DesktopControlToolCapabilities {
  mouse: boolean
  keyboard: boolean
}

/**
 * Builds the desktop-control LLM tools. `desktop_look` is always present (it only
 * needs screenshot access); mouse and keyboard tools are included per the enabled
 * capabilities so an off/unavailable backend never advertises input tools.
 */
export function desktopControlTools(capabilities: DesktopControlToolCapabilities): Promise<Tool[]> {
  const tools: Promise<Tool>[] = [
    tool({
      name: 'desktop_look',
      description: 'Look at the user\'s screen right now. Captures the screen and returns it to you as an image so you can see it directly. Call this before desktop_mouse so click coordinates are known.',
      execute: input => executeDesktopLook(input),
      parameters: desktopLookParams,
    }),
  ]

  if (capabilities.mouse) {
    tools.push(tool({
      name: 'desktop_mouse',
      description: 'Move, click, double-click, or scroll the real mouse. Coordinates are in the pixel space of the most recent desktop_look screenshot.',
      execute: input => executeDesktopMouse(input),
      parameters: desktopMouseParams,
    }))
  }

  if (capabilities.keyboard) {
    tools.push(tool({
      name: 'desktop_keyboard',
      description: 'Type text or press a keyboard shortcut on the real keyboard, sent to whatever window currently has focus.',
      execute: input => executeDesktopKeyboard(input),
      parameters: desktopKeyboardParams,
    }))
  }

  return Promise.all(tools)
}
