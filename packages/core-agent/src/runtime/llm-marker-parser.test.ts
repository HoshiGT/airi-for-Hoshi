import { describe, expect, it } from 'vitest'

import { useLlmmarkerParser } from './llm-marker-parser'

/**
 * @example
 * const parser = useLlmmarkerParser({ onLiteral, onSpecial })
 */
describe('useLlmmarkerParser', () => {
  /**
   * @example
   * Plain model text is emitted as literal output.
   */
  it('parses pure literals', async () => {
    const collectedLiterals: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
    })

    await parser.consume('Hello, world!')
    await parser.end()

    expect(collectedLiterals.join('')).toBe('Hello, world!')
  })

  /**
   * @example
   * `<|...|>` markers are emitted as special output.
   */
  it('parses special markers separately from literals', async () => {
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
      onSpecial: (special) => {
        collectedSpecials.push(special)
      },
    })

    await parser.consume('Hello <|ACT|> world')
    await parser.end()

    expect(collectedLiterals.join('')).toBe('Hello  world')
    expect(collectedSpecials).toEqual(['<|ACT|>'])
  })

  /**
   * @example
   * Unfinished markers are withheld instead of leaking into literal text.
   */
  it('does not include unfinished special markers', async () => {
    const collectedLiterals: string[] = []
    const collectedSpecials: string[] = []
    const parser = useLlmmarkerParser({
      onLiteral: (literal) => {
        collectedLiterals.push(literal)
      },
      onSpecial: (special) => {
        collectedSpecials.push(special)
      },
    })

    await parser.consume('<|unfinished')
    await parser.end()

    expect(collectedLiterals).toEqual([])
    expect(collectedSpecials).toEqual([])
  })

  // ROOT CAUSE:
  //
  // The stage system prompt instructs "Start every reply with an ACT token".
  // Weaker models recite that instruction literally, prefixing replies with
  // plain text like `ACT token: \n` instead of the marker-shaped
  // `<|ACT {...}|>`. The recital is not wrapped in `<|`/`|>`, so the parser
  // emitted it as literal text and it leaked into the visible/spoken reply.
  //
  // We fixed this by resolving the stream head before emitting literals:
  // a recited `ACT token:` prefix is swallowed, and when a bare JSON payload
  // follows it is re-emitted as a proper `<|ACT {...}|>` special.
  describe('recited ACT prefix at stream head', () => {
    async function parseAll(chunks: string[]) {
      const collectedLiterals: string[] = []
      const collectedSpecials: string[] = []
      const parser = useLlmmarkerParser({
        onLiteral: (literal) => {
          collectedLiterals.push(literal)
        },
        onSpecial: (special) => {
          collectedSpecials.push(special)
        },
      })
      for (const chunk of chunks)
        await parser.consume(chunk)
      await parser.end()
      return { literals: collectedLiterals.join(''), specials: collectedSpecials }
    }

    it('strips a recited "ACT token:" prefix before a proper marker', async () => {
      const { literals, specials } = await parseAll(['ACT token: \n<|ACT {"emotion":"happy"}|>你好呀！'])

      expect(literals).toBe('你好呀！')
      expect(specials).toEqual(['<|ACT {"emotion":"happy"}|>'])
    })

    it('strips a recited prefix followed by plain text', async () => {
      const { literals, specials } = await parseAll(['ACT token:\n哇，你来啦！'])

      expect(literals).toBe('哇，你来啦！')
      expect(specials).toEqual([])
    })

    it('converts a recited bare JSON payload into a proper ACT special', async () => {
      const { literals, specials } = await parseAll(['ACT token: {"emotion":"happy"}\n你好呀！'])

      expect(literals).toBe('你好呀！')
      expect(specials).toEqual(['<|ACT {"emotion":"happy"}|>'])
    })

    it('resolves a recital split across stream chunks', async () => {
      const { literals, specials } = await parseAll(['ACT tok', 'en: {"emo', 'tion":"curious"}', '\n可以打开吗？'])

      expect(literals).toBe('可以打开吗？')
      expect(specials).toEqual(['<|ACT {"emotion":"curious"}|>'])
    })

    it('keeps replies that merely start with similar words', async () => {
      const { literals } = await parseAll(['ACT tokens are a stage-control concept.'])

      expect(literals).toBe('ACT tokens are a stage-control concept.')
    })

    it('keeps "ACT token" mentions that appear mid-reply', async () => {
      const { literals } = await parseAll(['我听说过 ACT token: 它是控制情绪用的。'])

      expect(literals).toBe('我听说过 ACT token: 它是控制情绪用的。')
    })

    it('emits nothing when the whole reply is only a recital', async () => {
      const { literals, specials } = await parseAll(['ACT token:'])

      expect(literals).toBe('')
      expect(specials).toEqual([])
    })
  })
})
