/**
 * Hands a generated file to the user on the host platform.
 *
 * Resolves once the file has been delivered — saved, shared, or downloaded.
 * Rejecting is meaningful: callers surface it as a failed export.
 */
export type FileSaveHandler = (blob: Blob, filename: string) => Promise<void>

/**
 * Host-installed override for {@link saveFile}. `undefined` means "use the
 * browser default"; the last {@link setFileSaveHandler} call wins.
 */
let installedHandler: FileSaveHandler | undefined

/**
 * Installs the platform's file delivery handler, replacing the browser default.
 *
 * Call once during host app startup, before any export UI can run.
 *
 * Capacitor hosts must install one: the Android WebView registers no
 * `DownloadListener`, so the default anchor click below is silently dropped and
 * the user sees nothing happen. Verified against `@capacitor/android@8.3.1` —
 * the package contains no `setDownloadListener` call anywhere under
 * `capacitor/src/main/java/com/getcapacitor`.
 */
export function setFileSaveHandler(handler: FileSaveHandler): void {
  installedHandler = handler
}

/**
 * Characters that at least one target filesystem rejects. Windows bans the
 * whole set, Android bans the path separators, and control characters are
 * never valid in a name we generate.
 */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\p{Cc}]/gu

/**
 * Normalizes a filename so every target platform accepts it.
 *
 * Before:
 * - "airi-chat-sessions-2026-08-15T10:20:30.000Z.json"
 * - "夏/秋 卡片.zip"
 *
 * After:
 * - "airi-chat-sessions-2026-08-15T10-20-30.000Z.json"
 * - "夏-秋 卡片.zip"
 */
export function normalizeFilename(filename: string): string {
  const normalized = filename
    .replace(ILLEGAL_FILENAME_CHARS, '-')
    .trim()
    // Windows silently drops trailing dots and spaces, which would leave the
    // file under a different name than the one reported to the user.
    .replace(/[\s.]+$/, '')

  return normalized || 'download'
}

/**
 * Delivers a generated file to the user.
 *
 * The name is normalized first, so callers may pass raw user input (card
 * titles) or ISO timestamps without escaping them.
 *
 * Without a host handler this falls back to a synthetic `<a download>` click,
 * which browsers and Electron turn into a save. That path needs a DOM; in a
 * worker or on the server it throws rather than resolving as a no-op, so a
 * miswired export surfaces instead of looking like a user cancel.
 */
export async function saveFile(blob: Blob, filename: string): Promise<void> {
  const safeName = normalizeFilename(filename)

  if (installedHandler) {
    await installedHandler(blob, safeName)
    return
  }

  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL)
    throw new TypeError('saveFile requires a DOM; install a platform handler with setFileSaveHandler()')

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = safeName
  anchor.click()

  // Revoking in the same task can cancel the download the click just started,
  // so the URL is released after the browser has had a turn to fetch it.
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
