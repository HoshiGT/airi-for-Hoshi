import type { DesktopScreenshotGeometry } from '@proj-airi/stage-ui/stores/modules/desktop-control'
import type { Tool } from '@xsai/shared-chat'

import type {
  DesktopKeyboardAction,
  DesktopMouseAction,
  DesktopScreenshot,
  DesktopScreenshotRequest,
} from '../../../../shared/eventa'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { errorMessageFrom } from '@moeru/std'
import { useVisionInference } from '@proj-airi/stage-ui/composables/vision/use-vision-inference'
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
 * (one-shot screenshot routed through the vision model) and drive the mouse and
 * keyboard. Registered into the shared LLM tools store only while the
 * desktop-control module is enabled (see `stores/desktop-control-tools.ts`), so
 * these executes treat the store flags as a defense-in-depth re-check rather
 * than the primary gate.
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

/** Runs one multimodal look over a captured frame and returns the model's text. */
export type RunVisionLook = (input: { imageDataUrl: string, prompt: string }) => Promise<string>

export interface DesktopControlToolDeps {
  invokers?: DesktopControlInvokers
  store?: DesktopControlStoreLike
  runVision?: RunVisionLook
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

function resolveRunVision(override?: RunVisionLook): RunVisionLook {
  if (override)
    return override

  return async ({ imageDataUrl, prompt }) => {
    const { runVisionInference } = useVisionInference()
    // A vision provider/model must be configured in Settings → Modules → Vision;
    // reuse that config so the "eyes" and their model stay in one place.
    return runVisionInference({ imageDataUrl, workloadId: 'screen:interpret', promptOverride: prompt })
  }
}

const LOOK_PROMPTS = {
  describe: [
    'You are looking at a screenshot of the user\'s desktop.',
    'Describe concisely: the active app or window, the key UI elements, and what the user appears to be doing.',
    'Keep it factual and short.',
  ].join('\n'),
  read_text: [
    'You are looking at a screenshot of the user\'s desktop.',
    'Return the visible text, preserving structure with line breaks where possible.',
  ].join('\n'),
} as const

function buildLocatePrompt(target: string, image: DesktopScreenshot): string {
  return [
    `You are looking at a ${image.width}x${image.height} screenshot of the user's desktop.`,
    `Find the UI element described as: "${target}".`,
    'Report its center as pixel coordinates in THIS image, with the top-left as the origin.',
    'Answer in the form `(x, y) — <short confirmation>`. If it is not visible, say so plainly and do not invent coordinates.',
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

export async function executeDesktopLook(input: DesktopLookInput, deps?: DesktopControlToolDeps): Promise<string> {
  const store = resolveStore(deps?.store)
  if (!store.enabled)
    throw new Error('Desktop control is turned off. Enable it in Settings → Modules → Desktop control.')

  const invokers = resolveInvokers(deps?.invokers)
  const runVision = resolveRunVision(deps?.runVision)

  const screenshot = await invokers.screenshot({})
  // Retain the frame geometry so a follow-up desktop_mouse call can map the
  // model's in-image coordinates back onto the physical screen.
  store.setLastScreenshot(screenshot)

  const prompt = input.mode === 'locate'
    ? buildLocatePrompt(input.target.trim() || 'the element the user just referred to', screenshot)
    : LOOK_PROMPTS[input.mode]

  try {
    const text = await runVision({ imageDataUrl: screenshot.dataUrl, prompt })
    return text || 'The vision model returned no description.'
  }
  catch (error) {
    const message = errorMessageFrom(error) ?? 'Vision inference failed'
    if (/not configured/i.test(message))
      throw new Error('No vision model is configured. Set one in Settings → Modules → Vision so I can see the screen.')
    throw new Error(message)
  }
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
      description: 'Look at the user\'s screen right now. Returns a description, the on-screen text, or the pixel coordinates of a requested element. Call this before clicking so coordinates are known.',
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
