import type { FileSaveHandler } from './file-save'

import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `setFileSaveHandler` writes module-level state that no production code ever
 * uninstalls, so each case imports a fresh copy instead of exporting a reset
 * hook that only tests would call.
 */
async function importFreshFileSave() {
  vi.resetModules()
  return import('./file-save')
}

describe('normalizeFilename', () => {
  it('replaces the colons an ISO timestamp puts in a filename', async () => {
    const { normalizeFilename } = await importFreshFileSave()

    expect(normalizeFilename('airi-chat-sessions-2026-08-15T10:20:30.000Z.json'))
      .toBe('airi-chat-sessions-2026-08-15T10-20-30.000Z.json')
  })

  it('replaces path separators so a card title cannot escape the target directory', async () => {
    const { normalizeFilename } = await importFreshFileSave()

    expect(normalizeFilename('夏/秋 卡片.zip')).toBe('夏-秋 卡片.zip')
    expect(normalizeFilename('..\\..\\etc\\passwd.zip')).toBe('..-..-etc-passwd.zip')
  })

  it('replaces the remaining characters Windows rejects', async () => {
    const { normalizeFilename } = await importFreshFileSave()

    expect(normalizeFilename('a*b?c"d<e>f|g.json')).toBe('a-b-c-d-e-f-g.json')
  })

  it('strips control characters', async () => {
    const { normalizeFilename } = await importFreshFileSave()

    expect(normalizeFilename(`card${String.fromCharCode(0)}name${String.fromCharCode(31)}.zip`))
      .toBe('card-name-.zip')
  })

  it('drops trailing dots and spaces that Windows would silently remove', async () => {
    const { normalizeFilename } = await importFreshFileSave()

    expect(normalizeFilename('report. ')).toBe('report')
    expect(normalizeFilename('  spaced.json  ')).toBe('spaced.json')
  })

  it('falls back to a usable name when nothing survives', async () => {
    const { normalizeFilename } = await importFreshFileSave()

    // Illegal characters are substituted rather than dropped, so a name made
    // only of them still yields something writable.
    expect(normalizeFilename('///')).toBe('---')
    expect(normalizeFilename('')).toBe('download')
    expect(normalizeFilename('   ')).toBe('download')
  })
})

describe('saveFile', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('hands the blob to the installed platform handler', async () => {
    const { saveFile, setFileSaveHandler } = await importFreshFileSave()
    const handler = vi.fn<FileSaveHandler>(async () => {})
    setFileSaveHandler(handler)

    const blob = new Blob(['{}'], { type: 'application/json' })
    await saveFile(blob, 'sessions.json')

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toBe(blob)
    expect(handler.mock.calls[0][1]).toBe('sessions.json')
  })

  it('normalizes the filename before the platform handler sees it', async () => {
    const { saveFile, setFileSaveHandler } = await importFreshFileSave()
    const handler = vi.fn<FileSaveHandler>(async () => {})
    setFileSaveHandler(handler)

    await saveFile(new Blob(['{}']), 'airi-chat-sessions-2026-08-15T10:20:30.000Z.json')

    expect(handler.mock.calls[0][1]).toBe('airi-chat-sessions-2026-08-15T10-20-30.000Z.json')
  })

  it('propagates a handler failure so the caller can report the export as failed', async () => {
    const { saveFile, setFileSaveHandler } = await importFreshFileSave()
    setFileSaveHandler(async () => {
      throw new Error('user cancelled the share sheet')
    })

    await expect(saveFile(new Blob(['{}']), 'sessions.json'))
      .rejects
      .toThrow('user cancelled the share sheet')
  })

  it('keeps the last installed handler', async () => {
    const { saveFile, setFileSaveHandler } = await importFreshFileSave()
    const first = vi.fn<FileSaveHandler>(async () => {})
    const second = vi.fn<FileSaveHandler>(async () => {})
    setFileSaveHandler(first)
    setFileSaveHandler(second)

    await saveFile(new Blob(['{}']), 'sessions.json')

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('refuses to silently do nothing when there is neither a handler nor a DOM', async () => {
    // ROOT CAUSE:
    //
    // The default path is a synthetic `<a download>` click. Capacitor's Android
    // WebView registers no DownloadListener, so that click is dropped and the
    // export looks like it succeeded. A host that forgets to install a handler
    // must fail loudly rather than reproduce that silence.
    const { saveFile } = await importFreshFileSave()

    await expect(saveFile(new Blob(['{}']), 'sessions.json'))
      .rejects
      .toThrow(/requires a DOM/)
  })
})
