import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Whether the host can screenshot the desktop and synthesize input.
 *
 * Populated by the runtime that owns the OS boundary (the Electron app) and left
 * `null` on surfaces that cannot control the desktop at all (e.g. the web build),
 * so the shared settings page can render the right guidance without importing
 * any Electron-only contracts.
 */
export interface DesktopControlAvailability {
  screenshot: boolean
  input: boolean
  backend: string
  platform: string
  reason?: string
}

/**
 * Geometry of the most recent desktop frame shown to the vision model. Retained
 * so pointer actions expressed in the frame's pixel space can be mapped back to
 * absolute screen pixels for input synthesis.
 */
export interface DesktopScreenshotGeometry {
  /** Width of the frame the model saw, in pixels. */
  width: number
  /** Height of the frame the model saw, in pixels. */
  height: number
  /** Captured display's bounds in absolute device pixels (input coordinate space). */
  displayBounds: { x: number, y: number, width: number, height: number }
  capturedAt: number
}

/**
 * Translates a point in a screenshot's pixel space to absolute screen pixels.
 *
 * The frame is a uniformly scaled copy of the whole display, so the mapping is a
 * straight per-axis ratio against the display bounds. The point is clamped to the
 * frame first so a hallucinated coordinate can never fling the pointer off-screen.
 *
 * Before (frame 1280x800, display 2560x1600 at origin):
 * - `{ x: 640, y: 400 }`
 *
 * After:
 * - `{ x: 1280, y: 800 }`
 */
export function mapImagePointToScreen(
  point: { x: number, y: number },
  geometry: DesktopScreenshotGeometry,
): { x: number, y: number } {
  const { displayBounds } = geometry
  const scaleX = geometry.width > 0 ? displayBounds.width / geometry.width : 1
  const scaleY = geometry.height > 0 ? displayBounds.height / geometry.height : 1
  const clampedX = Math.min(Math.max(point.x, 0), geometry.width)
  const clampedY = Math.min(Math.max(point.y, 0), geometry.height)

  return {
    x: Math.round(displayBounds.x + clampedX * scaleX),
    y: Math.round(displayBounds.y + clampedY * scaleY),
  }
}

/**
 * Settings and live geometry for the desktop-control module (Neuro-style screen
 * vision plus mouse/keyboard control).
 *
 * Holds only electron-agnostic state so the shared settings UI can bind to it;
 * the actual screenshot/input dispatch lives in the Electron app, which also
 * feeds {@link DesktopControlAvailability} and the latest screenshot geometry back
 * into this store.
 */
export const useDesktopControlStore = defineStore('desktop-control', () => {
  const enabled = useLocalStorageManualReset<boolean>('settings/desktop-control/enabled', false)
  const mouseEnabled = useLocalStorageManualReset<boolean>('settings/desktop-control/mouse-enabled', true)
  const keyboardEnabled = useLocalStorageManualReset<boolean>('settings/desktop-control/keyboard-enabled', true)

  const availability = ref<DesktopControlAvailability | null>(null)
  const lastScreenshot = ref<DesktopScreenshotGeometry | null>(null)

  const configured = computed(() => enabled.value)
  const inputAvailable = computed(() => availability.value?.input ?? false)
  const canControlMouse = computed(() => enabled.value && mouseEnabled.value && inputAvailable.value)
  const canControlKeyboard = computed(() => enabled.value && keyboardEnabled.value && inputAvailable.value)

  function setAvailability(next: DesktopControlAvailability | null) {
    availability.value = next
  }

  function setLastScreenshot(next: DesktopScreenshotGeometry | null) {
    lastScreenshot.value = next
  }

  function resetState() {
    enabled.reset()
    mouseEnabled.reset()
    keyboardEnabled.reset()
    lastScreenshot.value = null
  }

  return {
    enabled,
    mouseEnabled,
    keyboardEnabled,
    availability,
    lastScreenshot,

    configured,
    inputAvailable,
    canControlMouse,
    canControlKeyboard,

    setAvailability,
    setLastScreenshot,
    resetState,
  }
})
