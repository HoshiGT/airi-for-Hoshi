import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetSystemMessageThrottleForTests, systemMessageEvent } from './system-message'

const filter = systemMessageEvent.mineflayer.filter!

function ctx(selfUsername = 'airi-bot'): any {
  return { selfUsername }
}

describe('system_message throttle', () => {
  beforeEach(() => {
    __resetSystemMessageThrottleForTests()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  it('ignores non-system chat positions entirely', () => {
    expect(filter(ctx(), 'hello', 'chat')).toBe(false)
  })

  it('lets the first generic broadcast through, then rate-limits the flood behind it', () => {
    expect(filter(ctx(), 'Steve joined the game', 'system')).toBe(true)
    expect(filter(ctx(), 'Alex joined the game', 'system')).toBe(false)
    expect(filter(ctx(), 'Bob joined the game', 'system')).toBe(false)
  })

  it('opens the gate again after the cooldown elapses', () => {
    expect(filter(ctx(), 'Steve joined the game', 'system')).toBe(true)

    vi.setSystemTime(new Date('2026-01-01T00:00:20Z'))
    expect(filter(ctx(), 'Alex joined the game', 'system')).toBe(false)

    vi.setSystemTime(new Date('2026-01-01T00:00:31Z'))
    expect(filter(ctx(), 'Bob joined the game', 'system')).toBe(true)
  })

  it('always passes messages naming the bot, regardless of cooldown', () => {
    expect(filter(ctx(), 'Steve joined the game', 'system')).toBe(true)

    // Cooldown is active, but someone is addressing us.
    expect(filter(ctx(), 'Steve whispers to airi-bot: come here', 'system')).toBe(true)
    expect(filter(ctx(), 'airi-bot was slain by a zombie', 'system')).toBe(true)
  })

  it('matches the bot name case-insensitively', () => {
    expect(filter(ctx('AiRi-Bot'), 'welcome AIRI-BOT', 'system')).toBe(true)
  })

  it('does not treat an empty bot name as matching everything', () => {
    expect(filter(ctx(''), 'Steve joined the game', 'system')).toBe(true) // first one, via cooldown
    expect(filter(ctx(''), 'Alex joined the game', 'system')).toBe(false) // and the rest are limited
  })
})
