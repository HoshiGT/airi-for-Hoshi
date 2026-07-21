import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { MemoryDatabase } from './db'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyMemorySchema } from './db'
import { MemoryRepository } from './repository'
import { memorySchema } from './schema'

const generateTextMock = vi.fn()

// The model call is the only external boundary here; storage runs against a
// real in-memory PGlite so the persisted rows are asserted for real.
vi.mock('@xsai/generate-text', () => ({
  generateText: (options: unknown) => generateTextMock(options),
}))

const { runConsolidation } = await import('./consolidation')

const provider: ChatProvider = {
  chat: model => ({ baseURL: 'http://localhost/', model }),
}

const modelReply = {
  summary: 'user configured the QQ bot',
  items: [
    { content: 'user runs a QQ bot', kind: 'long', importance: 0.9, keywords: ['QQ', 'bot'] },
    { content: 'user is testing today', kind: 'short', importance: 0.4, keywords: ['testing'] },
  ],
}

const messages: Message[] = [
  { role: 'user', content: 'help me set up the qq bot' },
  { role: 'assistant', content: 'sure, configure NapCat first' },
]

async function makeRepository(): Promise<MemoryRepository> {
  const db = drizzle(new PGlite(), { schema: memorySchema }) as unknown as MemoryDatabase
  await applyMemorySchema(db)
  return new MemoryRepository(db)
}

function sentSystemPrompt(): string {
  const options = generateTextMock.mock.calls[0][0] as { messages: Message[] }
  const system = options.messages.find(m => m.role === 'system')
  return String(system?.content)
}

beforeEach(() => {
  generateTextMock.mockReset().mockResolvedValue({ text: JSON.stringify(modelReply) })
})

describe('runConsolidation', () => {
  it('keeps the base system prompt when no guidance is set', async () => {
    const repository = await makeRepository()
    await runConsolidation({ provider, model: 'test-model', characterId: 'default', sessionId: 's1', messages, repository })

    expect(sentSystemPrompt()).not.toContain('preferences for what to remember')
  })

  it('appends user guidance after the core instructions', async () => {
    const repository = await makeRepository()
    await runConsolidation({
      provider,
      model: 'test-model',
      characterId: 'default',
      sessionId: 's1',
      messages,
      guidance: '重点记录我的猫的习惯，忽略寒暄。',
      repository,
    })

    const prompt = sentSystemPrompt()
    expect(prompt).toContain('重点记录我的猫的习惯，忽略寒暄。')
    // The JSON output contract must stay ahead of the guidance so a rambling
    // preference cannot override the response format.
    expect(prompt.indexOf('Respond with ONLY a JSON object')).toBeLessThan(prompt.indexOf('重点记录'))
  })

  it('ignores whitespace-only guidance', async () => {
    const repository = await makeRepository()
    await runConsolidation({ provider, model: 'test-model', characterId: 'default', sessionId: 's1', messages, guidance: '   \n', repository })

    expect(sentSystemPrompt()).not.toContain('preferences for what to remember')
  })

  it('returns the ids of the archive and memory rows it persisted', async () => {
    const repository = await makeRepository()
    const record = await runConsolidation({
      provider,
      model: 'test-model',
      characterId: 'default',
      sessionId: 's1',
      messages,
      roundFrom: 1,
      roundTo: 2,
      repository,
    })

    expect(record.summary).toBe('user configured the QQ bot')
    expect(record.memoryIds).toHaveLength(2)

    const archives = await repository.listArchivedSummaries('s1')
    expect(archives.map(a => a.id)).toEqual([record.archiveId])

    const items = await repository.listMemoryItems({ sessionId: 's1' })
    expect(items.map(i => i.id).sort()).toEqual([...record.memoryIds].sort())
  })
})
