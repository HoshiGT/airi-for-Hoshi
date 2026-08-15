import type { FileSaveHandler } from '@proj-airi/stage-shared'

import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { errorMessageFrom } from '@moeru/std'
import { setFileSaveHandler } from '@proj-airi/stage-shared'

/** `Filesystem.writeFile` takes the payload of a data URL, not the whole URL. */
async function encodeBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read the exported blob'))
    reader.onload = () => {
      if (typeof reader.result === 'string')
        resolve(reader.result)
      else
        reject(new TypeError('FileReader returned a buffer for readAsDataURL'))
    }
    reader.readAsDataURL(blob)
  })

  const payloadStart = dataUrl.indexOf(',')
  if (payloadStart < 0)
    throw new TypeError('FileReader returned a data URL without a payload')

  return dataUrl.slice(payloadStart + 1)
}

/**
 * Writes the export into app storage, then hands it to the system share sheet
 * so the user can move it off the device (chat app, cloud drive, USB target).
 */
const saveThroughShareSheet: FileSaveHandler = async (blob, filename) => {
  // Cache is the app-private directory covered by the FileProvider paths this
  // app ships (`android/app/src/main/res/xml/file_paths.xml` declares
  // `<cache-path path="." />`), and @capacitor/share resolves every shared file
  // through that provider — writing anywhere else fails with "Failed to find
  // configured root".
  //
  // The copy is left behind on purpose: the receiving app may still be reading
  // through the content URI when the share sheet returns, and Android reclaims
  // this directory on its own when storage runs low.
  const { uri } = await Filesystem.writeFile({
    path: filename,
    data: await encodeBase64(blob),
    directory: Directory.Cache,
  })

  try {
    await Share.share({ title: filename, files: [uri] })
  }
  catch (error) {
    // Dismissing the sheet rejects with "Share canceled"
    // (`SharePlugin.java:59-60`). That is the user declining to pick a target,
    // not a failed export, so it must not surface as an export error.
    if (errorMessageFrom(error)?.includes('canceled'))
      return

    throw error
  }
}

/**
 * Routes generated files through native storage + sharing on device.
 *
 * Must run before any export UI can be reached: the WebView drops the
 * `<a download>` click the shared default relies on, so without this an export
 * would appear to do nothing at all.
 *
 * No-op in the browser (`pnpm dev:web`), where the shared default works.
 */
export function installNativeFileSave(): void {
  if (!Capacitor.isNativePlatform())
    return

  setFileSaveHandler(saveThroughShareSheet)
}
