import type { ChatHistoryItem } from '../../../types/chat'

import { describe, expect, it } from 'vitest'

import { planConsolidation } from './trim'

function msg(role: ChatHistoryItem['role'], id: string, extra: Record<string, unknown> = {}): ChatHistoryItem {
  return { role, content: role, id, ...extra } as ChatHistoryItem
}

/** [system, (user, assistant) * rounds] — the shape a live session takes. */
function session(rounds: number): ChatHistoryItem[] {
  const messages: ChatHistoryItem[] = [msg('system', 'sys')]
  for (let i = 0; i < rounds; i++) {
    messages.push(msg('user', `u${i}`))
    messages.push(msg('assistant', `a${i}`))
  }
  return messages
}

describe('planConsolidation', () => {
  it('returns null below the trigger threshold', () => {
    const plan = planConsolidation(session(29), { triggerRounds: 30, retainRounds: 10 })
    expect(plan).toBeNull()
  })

  it('archives the oldest rounds once the threshold is reached', () => {
    const plan = planConsolidation(session(30), { triggerRounds: 30, retainRounds: 10 })
    expect(plan).not.toBeNull()
    // 30 rounds, retain 10 → archive the oldest 20 rounds = 40 messages.
    expect(plan!.archived).toHaveLength(40)
    expect(plan!.roundFrom).toBe(1)
    expect(plan!.roundTo).toBe(20)
  })

  it('collects archived message ids and excludes the system head', () => {
    const plan = planConsolidation(session(30), { triggerRounds: 30, retainRounds: 10 })
    expect(plan!.archivedIds.size).toBe(40)
    expect(plan!.archivedIds.has('sys')).toBe(false)
    expect(plan!.archivedIds.has('u0')).toBe(true)
    expect(plan!.archivedIds.has('a19')).toBe(true)
    // Round 20 (index 19) is the last archived; round 21 (u20) must stay live.
    expect(plan!.archivedIds.has('u20')).toBe(false)
  })

  it('groups interleaved tool messages into the round that produced them', () => {
    const messages: ChatHistoryItem[] = [msg('system', 'sys')]
    for (let i = 0; i < 30; i++) {
      messages.push(msg('user', `u${i}`))
      messages.push(msg('tool', `t${i}`, { tool_call_id: `tc${i}` }))
      messages.push(msg('assistant', `a${i}`))
    }
    const plan = planConsolidation(messages, { triggerRounds: 30, retainRounds: 10 })
    // 20 archived rounds × 3 messages each (user + tool + assistant).
    expect(plan!.archived).toHaveLength(60)
    expect(plan!.archivedIds.has('t0')).toBe(true)
    expect(plan!.archivedIds.has('t19')).toBe(true)
    expect(plan!.archivedIds.has('t20')).toBe(false)
  })

  it('grows the archived window as rounds accumulate past the trigger', () => {
    const plan = planConsolidation(session(35), { triggerRounds: 30, retainRounds: 10 })
    // 35 rounds, retain 10 → archive 25 rounds.
    expect(plan!.roundTo).toBe(25)
    expect(plan!.archived).toHaveLength(50)
  })

  it('returns null when there are no user-delimited rounds', () => {
    const plan = planConsolidation([msg('system', 'sys')], { triggerRounds: 1, retainRounds: 0 })
    expect(plan).toBeNull()
  })

  it('skips the trigger gate when triggerRounds is omitted (manual consolidate-now)', () => {
    // 5 rounds is far below any realistic trigger, but the manual pass
    // compresses everything older than the retained window anyway.
    const plan = planConsolidation(session(5), { retainRounds: 2 })
    expect(plan).not.toBeNull()
    expect(plan!.roundFrom).toBe(1)
    expect(plan!.roundTo).toBe(3)
    expect(plan!.archived).toHaveLength(6)
    expect(plan!.archivedIds.has('u2')).toBe(true)
    expect(plan!.archivedIds.has('u3')).toBe(false)
  })

  it('manual plan still returns null when everything fits the retained window', () => {
    const plan = planConsolidation(session(2), { retainRounds: 10 })
    expect(plan).toBeNull()
  })
})
