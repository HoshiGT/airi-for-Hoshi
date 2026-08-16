import type { DesktopScreenshot } from '../../../../shared/eventa'
import type { DesktopControlStoreLike, DesktopControlToolDeps } from './desktop-control'

import { describe, expect, it, vi } from 'vitest'

import { executeDesktopKeyboard, executeDesktopLook, executeDesktopMouse } from './desktop-control'

const SCREENSHOT: DesktopScreenshot = {
  dataUrl: 'data:image/jpeg;base64,AAAA',
  width: 1280,
  height: 800,
  displayBounds: { x: 0, y: 0, width: 2560, height: 1600 },
  displayId: '1',
  capturedAt: 0,
}

function makeStore(overrides: Partial<DesktopControlStoreLike> = {}): DesktopControlStoreLike {
  return {
    enabled: true,
    canControlMouse: true,
    canControlKeyboard: true,
    lastScreenshot: { width: 1280, height: 800, displayBounds: { x: 0, y: 0, width: 2560, height: 1600 }, capturedAt: 0 },
    setLastScreenshot: vi.fn(),
    ...overrides,
  }
}

function makeInvokers(overrides: Partial<NonNullable<DesktopControlToolDeps['invokers']>> = {}) {
  return {
    screenshot: vi.fn(async () => SCREENSHOT),
    mouse: vi.fn(async () => {}),
    keyboard: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('executeDesktopLook', () => {
  it('refuses when the module is disabled', async () => {
    await expect(executeDesktopLook({ mode: 'describe', target: '' }, { store: makeStore({ enabled: false }) }))
      .rejects
      .toThrowError(/turned off/)
  })

  it('captures a frame, stores its geometry, and returns the screenshot as an image block', async () => {
    const store = makeStore()
    const invokers = makeInvokers()

    const result = await executeDesktopLook({ mode: 'describe', target: '' }, { store, invokers })

    expect(invokers.screenshot).toHaveBeenCalledOnce()
    expect(store.setLastScreenshot).toHaveBeenCalledWith(SCREENSHOT)
    // Text hint first, then the frame itself — xsAI forwards this content-part
    // array verbatim so the chat model sees the screen directly.
    expect(result[0].type).toBe('text')
    expect(result[1]).toEqual({ type: 'image_url', image_url: { url: SCREENSHOT.dataUrl } })
  })

  it('builds a locate hint that names the target and image size', async () => {
    const result = await executeDesktopLook({ mode: 'locate', target: 'the Send button' }, { store: makeStore(), invokers: makeInvokers() })

    expect(result[0].type).toBe('text')
    expect(result[0].text).toContain('the Send button')
    expect(result[0].text).toContain('1280x800')
    expect(result[1].image_url.url).toBe(SCREENSHOT.dataUrl)
  })
})

describe('executeDesktopMouse', () => {
  it('maps screenshot-space coordinates to absolute screen pixels', async () => {
    const invokers = makeInvokers()
    const result = await executeDesktopMouse(
      { action: 'click', x: 640, y: 400, button: 'left', scrollAmount: 0 },
      { store: makeStore(), invokers },
    )

    expect(invokers.mouse).toHaveBeenCalledWith({ action: 'click', x: 1280, y: 800, button: 'left', scrollAmount: 0 })
    expect(result).toContain('(1280, 800)')
  })

  it('refuses when mouse control is unavailable', async () => {
    await expect(executeDesktopMouse(
      { action: 'move', x: 0, y: 0, button: 'left', scrollAmount: 0 },
      { store: makeStore({ canControlMouse: false }), invokers: makeInvokers() },
    )).rejects.toThrowError(/unavailable/)
  })

  it('requires a prior screenshot so coordinates can be mapped', async () => {
    await expect(executeDesktopMouse(
      { action: 'click', x: 10, y: 10, button: 'left', scrollAmount: 0 },
      { store: makeStore({ lastScreenshot: null }), invokers: makeInvokers() },
    )).rejects.toThrowError(/desktop_look/)
  })
})

describe('executeDesktopKeyboard', () => {
  it('types literal text through the input backend', async () => {
    const invokers = makeInvokers()
    const result = await executeDesktopKeyboard(
      { action: 'type', text: 'hello', keys: '' },
      { store: makeStore(), invokers },
    )

    expect(invokers.keyboard).toHaveBeenCalledWith({ action: 'type', text: 'hello' })
    expect(result).toContain('5 characters')
  })

  it('presses a key chord', async () => {
    const invokers = makeInvokers()
    await executeDesktopKeyboard({ action: 'key', text: '', keys: 'ctrl+c' }, { store: makeStore(), invokers })
    expect(invokers.keyboard).toHaveBeenCalledWith({ action: 'key', keys: 'ctrl+c' })
  })

  it('refuses when keyboard control is unavailable', async () => {
    await expect(executeDesktopKeyboard(
      { action: 'type', text: 'x', keys: '' },
      { store: makeStore({ canControlKeyboard: false }), invokers: makeInvokers() },
    )).rejects.toThrowError(/unavailable/)
  })
})
