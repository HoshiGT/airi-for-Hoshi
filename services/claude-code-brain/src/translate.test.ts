import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { chunkOf, completionOf, composeQueryInput, CONTEXT_HYGIENE_PREAMBLE, finalChunkOf, jsonSchemaToZodShape, reasoningChunkOf, resolveModelOption, toolCallChunkOf } from './translate'

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function textBlockOf(blocks: ReturnType<typeof composeQueryInput>['blocks']): string {
  const first = blocks[0]
  return first.type === 'text' ? first.text : ''
}

describe('composeQueryInput', () => {
  it('passes a single user message through without transcript framing', () => {
    const { systemPrompt, blocks } = composeQueryInput([
      { role: 'system', content: '你是 Airi。' },
      { role: 'user', content: '晚上好呀' },
    ])

    expect(systemPrompt).toBe(`${CONTEXT_HYGIENE_PREAMBLE}\n\n你是 Airi。`)
    expect(blocks).toEqual([{ type: 'text', text: '晚上好呀' }])
  })

  it('joins multiple system messages after the hygiene preamble', () => {
    const { systemPrompt } = composeQueryInput([
      { role: 'system', content: '角色卡' },
      { role: 'system', content: '## Toolset\n表情包规则' },
      { role: 'user', content: 'hi' },
    ])

    expect(systemPrompt).toBe(`${CONTEXT_HYGIENE_PREAMBLE}\n\n角色卡\n\n## Toolset\n表情包规则`)
  })

  it('still emits the hygiene preamble when no system message is present', () => {
    const { systemPrompt } = composeQueryInput([
      { role: 'user', content: 'hi' },
    ])

    expect(systemPrompt).toBe(CONTEXT_HYGIENE_PREAMBLE)
  })

  it('renders multi-turn history as a labeled transcript ending with an instruction', () => {
    const { blocks } = composeQueryInput([
      { role: 'user', content: '你叫什么?' },
      { role: 'assistant', content: '我是 Airi~' },
      { role: 'user', content: '刚才你说你叫什么来着?' },
    ])

    const prompt = textBlockOf(blocks)
    expect(prompt).toContain('[User]: 你叫什么?')
    expect(prompt).toContain('[You]: 我是 Airi~')
    expect(prompt.indexOf('[You]: 我是 Airi~')).toBeGreaterThan(prompt.indexOf('[User]: 你叫什么?'))
    expect(prompt.trim().endsWith('Output only your reply text.')).toBe(true)
  })

  it('replays tool calls and tool results in the transcript', () => {
    const { blocks } = composeQueryInput([
      { role: 'user', content: '现在几点了?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"tz":"utc"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'get_time', content: '12:00 UTC' },
    ])

    const prompt = textBlockOf(blocks)
    expect(prompt).toContain('[You called tool get_time with arguments: {"tz":"utc"}]')
    expect(prompt).toContain('[Tool get_time returned]: 12:00 UTC')
  })

  it('attaches images from tool results after the last assistant turn as image blocks', () => {
    const { blocks } = composeQueryInput([
      { role: 'user', content: '看看屏幕' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'desktop_look', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'desktop_look',
        content: [
          { type: 'text', text: 'screen is 1920x1080' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG}` } },
        ],
      },
    ])

    expect(blocks).toHaveLength(2)
    expect(blocks[0].type).toBe('text')
    expect(textBlockOf(blocks)).toContain('[Tool desktop_look returned]: screen is 1920x1080 (screenshot/image attached below)')
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: TINY_PNG },
    })
  })

  it('omits stale screenshots from earlier rounds but notes them in the transcript', () => {
    const { blocks } = composeQueryInput([
      { role: 'user', content: '看看屏幕' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'desktop_look', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'desktop_look',
        content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG}` } }],
      },
      { role: 'assistant', content: '我看到桌面了' },
      { role: 'user', content: '好,继续' },
    ])

    // Old screenshot is before the final assistant turn — dropped, not attached.
    expect(blocks.every(block => block.type === 'text')).toBe(true)
    expect(textBlockOf(blocks)).toContain('(older screenshot omitted)')
  })

  it('replays the full history by default (no cap)', () => {
    // 20 user rounds, no maxHistoryRounds option → nothing is dropped. Full
    // context is the default so the persona keeps the whole conversation.
    const messages = []
    for (let i = 1; i <= 20; i++) {
      messages.push({ role: 'user', content: `问题${i}` })
      messages.push({ role: 'assistant', content: `回答${i}` })
    }
    const { blocks } = composeQueryInput(messages)
    const prompt = textBlockOf(blocks)

    expect(prompt).not.toContain('(Earlier conversation omitted.)')
    expect(prompt).toContain('[User]: 问题1')
    expect(prompt).toContain('[User]: 问题20')
  })

  it('replays every round when the count is within the history cap', () => {
    const messages = [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '回一' },
      { role: 'user', content: '第二句' },
    ]
    const { blocks } = composeQueryInput(messages, { maxHistoryRounds: 2 })
    const prompt = textBlockOf(blocks)

    expect(prompt).not.toContain('(Earlier conversation omitted.)')
    expect(prompt).toContain('[User]: 第一句')
    expect(prompt).toContain('[User]: 第二句')
  })

  it('drops rounds older than maxHistoryRounds and inserts an omission marker', () => {
    // 3 user turns, cap of 1 → only the last user turn survives; the earlier
    // two collapse to the marker. This is the core token-growth guard.
    const messages = [
      { role: 'user', content: '轮一' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '轮二' },
      { role: 'assistant', content: '答二' },
      { role: 'user', content: '轮三' },
    ]
    const { blocks } = composeQueryInput(messages, { maxHistoryRounds: 1 })
    const prompt = textBlockOf(blocks)

    expect(prompt).toContain('(Earlier conversation omitted.)')
    expect(prompt).not.toContain('轮一')
    expect(prompt).not.toContain('答一')
    expect(prompt).not.toContain('轮二')
    expect(prompt).not.toContain('答二')
    expect(prompt).toContain('[User]: 轮三')
    // The marker leads the transcript, before any kept dialogue line.
    expect(prompt.indexOf('(Earlier conversation omitted.)')).toBeLessThan(prompt.indexOf('[User]: 轮三'))
  })

  it('keeps system prompt intact regardless of history truncation', () => {
    const messages = [
      { role: 'system', content: '你是 Airi。' },
      { role: 'user', content: '轮一' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '轮二' },
    ]
    const { systemPrompt, blocks } = composeQueryInput(messages, { maxHistoryRounds: 1 })

    expect(systemPrompt).toBe(`${CONTEXT_HYGIENE_PREAMBLE}\n\n你是 Airi。`)
    expect(textBlockOf(blocks)).not.toContain('轮一')
    expect(textBlockOf(blocks)).toContain('[User]: 轮二')
  })

  it('clips long tool-call arguments in the transcript', () => {
    const longArgs = JSON.stringify({ q: 'x'.repeat(500) })
    const { blocks } = composeQueryInput([
      { role: 'user', content: '搜一下' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: longArgs } }],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'web_search', content: 'ok' },
    ])
    const prompt = textBlockOf(blocks)

    expect(prompt).toContain('…[+')
    expect(prompt).not.toContain('x'.repeat(500))
  })

  it('clips replayed (historical) tool results but keeps the current round whole', () => {
    const longResult = 'r'.repeat(2000)
    const freshResult = 'f'.repeat(2000)
    const { blocks } = composeQueryInput([
      { role: 'user', content: '第一次搜' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
      },
      // Historical tool result: before the final assistant turn → clipped.
      { role: 'tool', tool_call_id: 'call_1', name: 'web_search', content: longResult },
      { role: 'assistant', content: '找到了' },
      { role: 'user', content: '再搜一次' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
      },
      // Current round result (after the last assistant turn) → kept whole.
      { role: 'tool', tool_call_id: 'call_2', name: 'web_search', content: freshResult },
    ])
    const prompt = textBlockOf(blocks)

    expect(prompt).not.toContain(longResult)
    expect(prompt).toContain('…[+')
    expect(prompt).toContain(freshResult)
  })

  it('drops unsupported image formats and remote URLs', () => {
    const { blocks } = composeQueryInput([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这两张' },
          { type: 'image_url', image_url: { url: 'data:image/tiff;base64,AAAA' } },
          { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
        ],
      },
    ])

    expect(blocks.every(block => block.type === 'text')).toBe(true)
  })
})

describe('jsonSchemaToZodShape', () => {
  it('converts a desktop-control-style schema into a validating zod shape', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'click', 'double_click'], description: 'What to do' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        button: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['action', 'x', 'y', 'button'],
    })

    const parsed = z.object(shape).parse({ action: 'click', x: 10, y: 20, button: null })
    expect(parsed).toEqual({ action: 'click', x: 10, y: 20, button: null })
    expect(() => z.object(shape).parse({ action: 'fly', x: 1, y: 2, button: null })).toThrow()
  })

  it('marks non-required properties optional', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    })

    expect(z.object(shape).parse({ query: 'hi' })).toEqual({ query: 'hi' })
  })

  it('returns an empty shape for missing or non-object parameters', () => {
    expect(jsonSchemaToZodShape(undefined)).toEqual({})
    expect(jsonSchemaToZodShape({ type: 'string' })).toEqual({})
  })
})

describe('resolveModelOption', () => {
  it('omits the model option for default', () => {
    expect(resolveModelOption('default')).toBeUndefined()
    expect(resolveModelOption(undefined)).toBeUndefined()
    expect(resolveModelOption('')).toBeUndefined()
  })

  it('passes explicit models through', () => {
    expect(resolveModelOption('claude-sonnet-5')).toBe('claude-sonnet-5')
  })
})

describe('openai wire shapes', () => {
  it('builds a valid streaming chunk', () => {
    const parsed = JSON.parse(chunkOf('id-1', 'default', '你好'))
    expect(parsed.object).toBe('chat.completion.chunk')
    expect(parsed.choices[0].delta.content).toBe('你好')
    expect(parsed.choices[0].finish_reason).toBeNull()
  })

  it('builds a reasoning chunk that xsAI maps to reasoning-delta, never text content', () => {
    const parsed = JSON.parse(reasoningChunkOf('id-1', 'default', '嗯,用户想…'))
    expect(parsed.object).toBe('chat.completion.chunk')
    // xsAI's stream parser keys reasoning on `delta.reasoning_content` (the
    // DeepSeek R1 field); `delta.content` must stay absent or the thinking
    // would land in Airi's chat bubble as reply text.
    expect(parsed.choices[0].delta.reasoning_content).toBe('嗯,用户想…')
    expect(parsed.choices[0].delta.content).toBeUndefined()
    expect(parsed.choices[0].finish_reason).toBeNull()
  })

  it('builds a tool-call chunk in OpenAI format', () => {
    const parsed = JSON.parse(toolCallChunkOf('id-1', 'default', [
      { id: 'call_a', name: 'desktop_look', arguments: '{"detail":"full"}' },
    ]))

    expect(parsed.choices[0].delta.tool_calls).toEqual([{
      index: 0,
      id: 'call_a',
      type: 'function',
      function: { name: 'desktop_look', arguments: '{"detail":"full"}' },
    }])
  })

  it('builds a terminal chunk with usage totals and configurable finish reason', () => {
    const stop = JSON.parse(finalChunkOf('id-1', 'default', { input_tokens: 10, output_tokens: 5 }))
    expect(stop.choices[0].finish_reason).toBe('stop')
    expect(stop.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })

    const toolCalls = JSON.parse(finalChunkOf('id-1', 'default', undefined, 'tool_calls'))
    expect(toolCalls.choices[0].finish_reason).toBe('tool_calls')
  })

  it('builds a non-streaming completion', () => {
    const parsed = JSON.parse(completionOf('id-1', 'claude-sonnet-5', '回复', { input_tokens: 1, output_tokens: 2 }))
    expect(parsed.object).toBe('chat.completion')
    expect(parsed.choices[0].message).toEqual({ role: 'assistant', content: '回复' })
    expect(parsed.usage.total_tokens).toBe(3)
  })

  it('builds a non-streaming completion carrying tool calls', () => {
    const parsed = JSON.parse(completionOf('id-1', 'default', '', undefined, [
      { id: 'call_a', name: 'get_time', arguments: '{}' },
    ]))

    expect(parsed.choices[0].finish_reason).toBe('tool_calls')
    expect(parsed.choices[0].message.content).toBeNull()
    expect(parsed.choices[0].message.tool_calls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'get_time', arguments: '{}' } },
    ])
  })
})
