import { saveFile } from '@proj-airi/stage-shared'

/**
 * Prepares a download of `data` under `filename`.
 *
 * Delivery is delegated to {@link saveFile}, so mobile hosts that cannot handle
 * an anchor click still receive the file through their own handler.
 */
export function useDownload(data: Blob, filename: string) {
  return {
    download: () => saveFile(data, filename),
  }
}
