import { describe, expect, it } from 'vitest'

import { formatStickerMarker, parseStickerMarker } from './sticker-marker'

describe('sticker marker contract', () => {
  it('round-trips names through format and parse', () => {
    expect(parseStickerMarker(formatStickerMarker('疑惑猫猫'))).toBe('疑惑猫猫')
    expect(parseStickerMarker(formatStickerMarker('thumbs up'))).toBe('thumbs up')
  })

  it('ignores non-sticker specials', () => {
    expect(parseStickerMarker('<|EMOTE_HAPPY|>')).toBeUndefined()
    expect(parseStickerMarker('<|ACT {"emotion":"happy"}|>')).toBeUndefined()
    expect(parseStickerMarker('plain text')).toBeUndefined()
  })

  it('rejects empty and whitespace-only names', () => {
    expect(parseStickerMarker('<|STICKER_|>')).toBeUndefined()
    expect(parseStickerMarker('<|STICKER_   |>')).toBeUndefined()
  })

  it('trims surrounding whitespace the model may add around the name', () => {
    expect(parseStickerMarker('<|STICKER_ 摆烂 |>')).toBe('摆烂')
  })
})
