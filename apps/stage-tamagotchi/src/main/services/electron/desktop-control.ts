import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { DesktopControlAvailability, DesktopScreenshot, DesktopScreenshotRequest } from '../../../shared/eventa'

import process from 'node:process'

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import { desktopCapturer, screen } from 'electron'

import {
  desktopControlGetAvailability,
  desktopControlKeyboard,
  desktopControlMouse,
  desktopControlScreenshot,
} from '../../../shared/eventa'
import { buildKeyboardArgs, buildMouseArgs } from './desktop-control-input'

const execFileAsync = promisify(execFile)

const DEFAULT_MAX_WIDTH = 1280
const DEFAULT_MAX_HEIGHT = 800
// Quality/size tradeoff for the frame handed to the vision model; the screen is
// already downscaled so 80 keeps text legible without bloating the payload.
const SCREENSHOT_JPEG_QUALITY = 80

/**
 * Probes whether OS input synthesis is available.
 *
 * We deliberately do not cache the result: `xdotool` may be installed while the
 * app is running, and the probe (`xdotool --version`) is cheap. Screenshot
 * support is always true inside Electron via `desktopCapturer`.
 */
async function resolveAvailability(): Promise<DesktopControlAvailability> {
  const platform = process.platform

  if (platform !== 'linux') {
    return {
      screenshot: true,
      input: false,
      backend: 'none',
      platform,
      reason: `Mouse and keyboard control is only wired for Linux/X11 so far; ${platform} is not supported yet.`,
    }
  }

  try {
    await execFileAsync('xdotool', ['--version'])
    return { screenshot: true, input: true, backend: 'xdotool', platform }
  }
  catch {
    return {
      screenshot: true,
      input: false,
      backend: 'none',
      platform,
      reason: 'xdotool was not found on PATH. Install it (e.g. `sudo apt install xdotool`) to let the character move the mouse and type.',
    }
  }
}

/**
 * Captures the primary display and returns it as a downscaled JPEG data URL
 * along with the display's device-pixel bounds.
 *
 * The bounds let the renderer translate the model's in-image click coordinates
 * back to absolute screen pixels: the frame is a scaled copy of the whole
 * display, so mapping is a straight per-axis ratio against these bounds.
 */
async function captureScreenshot(request?: DesktopScreenshotRequest): Promise<DesktopScreenshot> {
  const primary = screen.getPrimaryDisplay()
  const scale = primary.scaleFactor || 1

  // `desktopCapturer` thumbnails and xdotool both operate in device pixels,
  // while Electron reports display bounds in DIP — multiply back to device px.
  const deviceWidth = Math.round(primary.bounds.width * scale)
  const deviceHeight = Math.round(primary.bounds.height * scale)

  const maxWidth = request?.maxWidth ?? DEFAULT_MAX_WIDTH
  const maxHeight = request?.maxHeight ?? DEFAULT_MAX_HEIGHT
  // Fit the capture inside the requested box, preserving aspect, never upscaling.
  const ratio = Math.min(maxWidth / deviceWidth, maxHeight / deviceHeight, 1)
  const thumbWidth = Math.max(1, Math.round(deviceWidth * ratio))
  const thumbHeight = Math.max(1, Math.round(deviceHeight * ratio))

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbWidth, height: thumbHeight },
  })

  const source = sources.find(candidate => candidate.display_id === String(primary.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty())
    throw new Error('No screen source was available to capture')

  const image = source.thumbnail
  const size = image.getSize()

  return {
    dataUrl: `data:image/jpeg;base64,${image.toJPEG(SCREENSHOT_JPEG_QUALITY).toString('base64')}`,
    width: size.width,
    height: size.height,
    displayBounds: {
      x: Math.round(primary.bounds.x * scale),
      y: Math.round(primary.bounds.y * scale),
      width: deviceWidth,
      height: deviceHeight,
    },
    displayId: String(primary.id),
    capturedAt: Date.now(),
  }
}

async function runXdotool(args: string[]): Promise<void> {
  try {
    await execFileAsync('xdotool', args)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('xdotool is not installed; cannot control the mouse or keyboard.')
    throw new Error(errorMessageFrom(error) ?? 'xdotool command failed')
  }
}

/**
 * Wires the desktop-control eventa handlers (screenshot + input synthesis) onto
 * a window context.
 *
 * These handlers execute whatever they are asked — the enable/permission gate
 * lives in the renderer's desktop-control module, which only registers the LLM
 * tools while the feature is switched on.
 */
export function createDesktopControlService(params: { context: ReturnType<typeof createContext>['context'] }) {
  defineInvokeHandler(params.context, desktopControlGetAvailability, () => resolveAvailability())
  defineInvokeHandler(params.context, desktopControlScreenshot, request => captureScreenshot(request))
  defineInvokeHandler(params.context, desktopControlMouse, action => runXdotool(buildMouseArgs(action)))
  defineInvokeHandler(params.context, desktopControlKeyboard, action => runXdotool(buildKeyboardArgs(action)))
}
