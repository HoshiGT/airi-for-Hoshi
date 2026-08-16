import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { generateBrainSystemPrompt } from './brain-prompt'

describe('generateBrainSystemPrompt', () => {
  it('includes chat feedback loop guard guidance', () => {
    const prompt = generateBrainSystemPrompt([
      {
        name: 'chat',
        description: 'Send a chat message',
        execution: 'sync',
        schema: z.object({ message: z.string(), feedback: z.boolean().optional() }),
        perform: () => () => '',
      },
    ] as any)

    expect(prompt).toContain('Feedback Loop Guard')
    expect(prompt).toContain('chat->feedback->chat')
    expect(prompt).toContain('Query DSL')
    expect(prompt).toContain('Heuristic composition examples')
    expect(prompt).toContain('llmLog')
    expect(prompt).toContain('actionQueue')
    expect(prompt).toContain('1 executing + 4 pending')
    expect(prompt).toContain('Silent-eval pattern')
    expect(prompt).toContain('Value-first rule')
    expect(prompt).toContain('forget_conversation()')
    expect(prompt).toContain('setNoActionBudget(n)')
    expect(prompt).toContain('getNoActionBudget()')
    expect(prompt).toContain('noActionBudget')
    expect(prompt).toContain('errorBurstGuard')
    expect(prompt).toContain('patterns.get(id)')
    expect(prompt).toContain('patterns.find(query)')
    expect(prompt).toContain('Never return function references as values')
    expect(prompt).toContain('query.inventory().summary()')
    expect(prompt).toContain('Default no-action follow-up budget is 3 and max is 8')
    expect(prompt).toContain('do not stay in repeated evaluation-only turns')
    expect(prompt).toContain('Error Burst Guard')
    expect(prompt).toContain('COMBAT: commit') // commit-to-combat / don't-thrash guidance
    expect(prompt).toContain('LET THE ATTACK FINISH')
  })

  const chatAction = [{
    name: 'chat',
    description: 'Send a chat message',
    execution: 'sync',
    schema: z.object({ message: z.string() }),
    perform: () => () => '',
  }] as any

  it('binds the master and enforces master-only command authority when a master username is set', () => {
    const prompt = generateBrainSystemPrompt(chatAction, { masterUsername: 'dssadg' })

    expect(prompt).toContain('主人身份')
    expect(prompt).toContain('主人 = dssadg')
    expect(prompt).toContain('只听主人的指令') // only the master's commands are authoritative
    expect(prompt).toContain('别的玩家') // other players are handled cautiously
    expect(prompt).toContain('默认不要照做')
  })

  it('omits the master identity section when no master username is configured', () => {
    const prompt = generateBrainSystemPrompt(chatAction)

    expect(prompt).not.toContain('主人身份')
    expect(prompt).not.toContain('只听主人的指令')
  })

  it('tells the model to reach for high-level tools before hand-assembling primitives', () => {
    const prompt = generateBrainSystemPrompt(chatAction)

    expect(prompt).toContain('Choosing a tool')
    expect(prompt).toContain('goToNearestEntity')
    expect(prompt).toContain('ensure*')
    expect(prompt).toContain('Reading tool results')
    expect(prompt).toContain('targetNotFound')
  })

  describe('startup summary', () => {
    it('renders the recovered facts as advisory context, not as instructions', () => {
      const prompt = generateBrainSystemPrompt(chatAction, {
        startupSummary: '家在 (100, 64, -200),主人叫我小艾。',
      })

      expect(prompt).toContain('上次会话记得的事')
      expect(prompt).toContain('家在 (100, 64, -200),主人叫我小艾。')
      // Framed as a hint that observation overrides, since the facts may be stale.
      expect(prompt).toContain('以观察为准')
    })

    it('is omitted entirely when there is nothing to recover', () => {
      expect(generateBrainSystemPrompt(chatAction)).not.toContain('上次会话记得的事')
      expect(generateBrainSystemPrompt(chatAction, { startupSummary: '   ' })).not.toContain('上次会话记得的事')
    })

    // The whole point of P0-4 is that a generated paragraph must never displace or dilute the
    // hardcoded safety rules. They are asserted verbatim, and asserted to come last.
    it('keeps the hardcoded safety rules verbatim and after the generated summary', () => {
      const prompt = generateBrainSystemPrompt(chatAction, {
        masterUsername: 'dssadg',
        startupSummary: '上次在挖矿。',
      })

      expect(prompt).toContain('绝不攻击主人')
      expect(prompt).toContain('只听主人的指令')
      expect(prompt).toContain('主人 = dssadg')
      expect(prompt).toContain('绝不要把别的玩家当成主人')

      expect(prompt.indexOf('上次会话记得的事')).toBeLessThan(prompt.indexOf('主人身份'))
    })
  })
})
