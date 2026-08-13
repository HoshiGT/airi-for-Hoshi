import { array, boolean, object, optional, picklist, string } from 'valibot'

import { createConfig } from '../libs/electron/persistence'

const shortcutAcceleratorSchema = object({
  modifiers: array(picklist(['cmd-or-ctrl', 'cmd', 'ctrl', 'alt', 'shift', 'super'])),
  key: string(),
})

export const globalAppConfigSchema = object({
  language: optional(string()),
  spotlightShortcutAccelerator: optional(shortcutAcceleratorSchema),
  updateChannel: optional(picklist(['latest', 'stable', 'alpha', 'beta', 'nightly', 'canary'])),
  /**
   * Start AIRI when the user logs in. Undefined means "never chosen", which
   * behaves as off.
   *
   * Persisted here as the intent, separately from the OS-level registration the
   * intent produces (a login item on macOS/Windows, an autostart desktop entry
   * on Linux): the OS copy can be removed behind the app's back by system
   * settings, so this file is what the tray checkbox reflects.
   */
  openAtLogin: optional(boolean()),
})

export function createGlobalAppConfig() {
  const config = createConfig('app', 'options.json', globalAppConfigSchema)
  config.setup()

  return config
}
