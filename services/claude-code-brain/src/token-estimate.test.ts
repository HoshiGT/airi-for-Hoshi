import { describe, expect, it } from 'vitest'

import { estimateQueryTokens } from './token-estimate'

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('estimateQueryTokens', () => {
  it('estimates text components at ~chars/3.5 and sums the total', () => {
    // 35-char system prompt / 70-char transcript → 10 / 20 tokens.
    const breakdown = estimateQueryTokens({
      systemPrompt: 'x'.repeat(35),
      blocks: [{ type: 'text', text: 'y'.repeat(70) }],
      tools: [],
    })

    expect(breakdown.systemPromptTokens).toBe(10)
    expect(breakdown.transcriptTokens).toBe(20)
    expect(breakdown.imageTokens).toBe(0)
    expect(breakdown.imageCount).toBe(0)
    expect(breakdown.toolTokens).toBe(0)
    expect(breakdown.totalTokens).toBe(30)
  })

  it('counts image blocks and estimates their tokens from base64 size', () => {
    const breakdown = estimateQueryTokens({
      systemPrompt: '',
      blocks: [
        { type: 'text', text: '看这张' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } },
      ],
      tools: [],
    })

    expect(breakdown.imageCount).toBe(1)
    expect(breakdown.imageTokens).toBe(Math.round(TINY_PNG.length / 750))
    expect(breakdown.totalTokens).toBe(breakdown.transcriptTokens + breakdown.imageTokens)
  })

  it('estimates tool-definition tokens from the serialized function object', () => {
    const tool = {
      type: 'function' as const,
      function: {
        name: 'web_search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    }
    const serializedTokens = Math.round(JSON.stringify(tool.function).length / 3.5)

    const breakdown = estimateQueryTokens({ systemPrompt: '', blocks: [], tools: [tool] })

    expect(breakdown.toolTokens).toBe(serializedTokens)
    expect(breakdown.totalTokens).toBe(serializedTokens)
  })
})
