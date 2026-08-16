import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { argv, env, execPath } from 'node:process'

import { app } from 'electron'
import { isLinux } from 'std-env'

/**
 * Argument the app passes to itself when the OS starts it at login.
 *
 * Read by the main window setup to come up as tray-only: a companion that
 * launches into your face on every boot is worse than one you summon from the
 * tray. Exported so both the registration side and the reader agree on it.
 */
export const LAUNCHED_AT_LOGIN_FLAG = '--launched-at-login'

/** Autostart entry filename; matches the packaged desktop entry's app id. */
const LINUX_AUTOSTART_ENTRY = 'ai.moeru.airi.desktop'

function linuxAutostartDirectory(): string {
  // XDG: autostart entries live under $XDG_CONFIG_HOME/autostart, and
  // $XDG_CONFIG_HOME itself defaults to ~/.config when unset.
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config')
  return join(configHome, 'autostart')
}

function linuxAutostartEntryPath(): string {
  return join(linuxAutostartDirectory(), LINUX_AUTOSTART_ENTRY)
}

/**
 * The command an autostart entry should run.
 *
 * AppImage is the awkward case: `process.execPath` points at the unpacked
 * binary inside the temporary mount, which is gone by the next boot, so the
 * `APPIMAGE` path (set by the runtime) is the only durable target.
 */
function linuxLaunchCommand(): string {
  const executable = env.APPIMAGE?.trim() || execPath
  return `"${executable}" ${LAUNCHED_AT_LOGIN_FLAG}`
}

/**
 * Desktop entry contents for the autostart copy.
 *
 * Deliberately minimal — it exists to launch the app, not to appear in menus.
 * `X-GNOME-Autostart-enabled` is what GNOME's own autostart UI toggles, so it is
 * written explicitly rather than left to the default.
 */
function linuxAutostartEntry(): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=AIRI',
    `Exec=${linuxLaunchCommand()}`,
    'Terminal=false',
    'Icon=ai.moeru.airi',
    'X-GNOME-Autostart-enabled=true',
    'Comment=Start AIRI in the tray when you log in',
    '',
  ].join('\n')
}

/**
 * Register or unregister "start when I log in" with the OS.
 *
 * Platform split is not cosmetic: Electron's `setLoginItemSettings` only
 * implements macOS and Windows, so Linux is handled by writing the XDG autostart
 * desktop entry that GNOME/KDE read at session start.
 *
 * Failures are surfaced to the caller (they are user-visible — the checkbox
 * would otherwise lie) but never thrown from a place that could take the tray
 * down with it; see the tray's handler.
 */
export async function applyOpenAtLogin(enabled: boolean): Promise<void> {
  if (isLinux) {
    if (!enabled) {
      // `force: true` keeps "already absent" from being an error.
      await rm(linuxAutostartEntryPath(), { force: true })
      return
    }

    await mkdir(linuxAutostartDirectory(), { recursive: true })
    await writeFile(linuxAutostartEntryPath(), linuxAutostartEntry(), 'utf-8')
    return
  }

  app.setLoginItemSettings({
    openAtLogin: enabled,
    // macOS reads `args` for the login-item launch; Windows appends them to the
    // registered command line.
    args: [LAUNCHED_AT_LOGIN_FLAG],
  })
}

/**
 * Whether this process was started by the OS session rather than by the user.
 *
 * Covers both the flag we register ourselves and macOS's own
 * `wasOpenedAtLogin`, which is set even when the login item predates the flag.
 */
export function wasLaunchedAtLogin(): boolean {
  if (argv.includes(LAUNCHED_AT_LOGIN_FLAG))
    return true

  if (isLinux)
    return false

  return app.getLoginItemSettings().wasOpenedAtLogin
}
