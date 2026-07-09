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

  it('captures a frame, stores its geometry, and returns the vision text', async () => {
    const store = makeStore()
    const invokers = makeInvokers()
    const runVision = vi.fn(async () => 'A code editor is open.')

    const result = await executeDesktopLook({ mode: 'describe', target: '' }, { store, invokers, runVision })

    expect(invokers.screenshot).toHaveBeenCalledOnce()
    expect(store.setLastScreenshot).toHaveBeenCalledWith(SCREENSHOT)
    expect(runVision).toHaveBeenCalledWith({ imageDataUrl: SCREENSHOT.dataUrl, prompt: expect.any(String) })
    expect(result).toBe('A code editor is open.')
  })

  it('builds a locate prompt that names the target and image size', async () => {
    const runVision = vi.fn(async () => '(100, 200) — found it')
    await executeDesktopLook({ mode: 'locate', target: 'the Send button' }, { store: makeStore(), invokers: makeInvokers(), runVision })

    expect(runVision).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('the Send button') }))
    expect(runVision).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('1280x800') }))
  })

  it('maps a vision configuration error to actionable guidance', async () => {
    const runVision = vi.fn(async () => {
      throw new Error('Vision provider/model not configured')
    })
    await expect(executeDesktopLook({ mode: 'describe', target: '' }, { store: makeStore(), invokers: makeInvokers(), runVision }))
      .rejects
      .toThrowError(/Settings → Modules → Vision/)
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
