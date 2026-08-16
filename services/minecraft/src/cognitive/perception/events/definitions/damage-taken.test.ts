import { beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetDamageEscalationLatchForTests, damageTakenEvent } from './damage-taken'

const filter = damageTakenEvent.mineflayer.filter!
const extract = damageTakenEvent.mineflayer.extract

vi.mock('./attacker-tracker', () => ({ recentAttacker: () => null }))
vi.mock('./fall-tracker', () => ({ classifyRecentFall: () => false }))
vi.mock('../../../../utils/mcdata', () => ({
  isHostile: (entity: { type?: string }) => entity?.type === 'mob',
}))

interface StubOptions {
  /** Hostile mobs standing within siege radius. */
  hostiles?: number
  /** Hostiles placed far away, to prove distance is respected. */
  distantHostiles?: number
  players?: number
  inLava?: boolean
  onFire?: boolean
  inWater?: boolean
}

/**
 * Perception-context stub. Entities are handed out with a distance so the siege count can be
 * exercised, and `bot.health` drives the damage delta the filter computes.
 */
function ctx(health: number, options: StubOptions = {}): any {
  const entities: Record<string, any> = {}
  let id = 0

  for (let i = 0; i < (options.hostiles ?? 0); i++)
    entities[`h${id++}`] = { type: 'mob', name: 'zombie', __distance: 5 }
  for (let i = 0; i < (options.distantHostiles ?? 0); i++)
    entities[`f${id++}`] = { type: 'mob', name: 'zombie', __distance: 40 }
  for (let i = 0; i < (options.players ?? 0); i++)
    entities[`p${id++}`] = { type: 'player', username: 'someone', __distance: 3 }

  return {
    bot: {
      health,
      entity: {
        isInLava: options.inLava ?? false,
        isOnFire: options.onFire ?? false,
        isInWater: options.inWater ?? false,
      },
      entities,
    },
    selfUsername: 'bot',
    maxDistance: 32,
    distanceTo: (entity: any) => entity?.__distance ?? null,
    isSelf: () => false,
    entityId: (entity: any) => String(entity?.name ?? 'x'),
  }
}

/** Seed `lastHealth` so the next call produces a real damage delta. */
function prime(health = 20) {
  filter(ctx(health))
}

describe('damage_taken escalation gate', () => {
  beforeEach(() => {
    __resetDamageEscalationLatchForTests()
    vi.useRealTimers()
  })

  it('stays quiet for a single zombie chipping away — the defend reflex handles that', () => {
    prime()
    expect(filter(ctx(18, { hostiles: 1 }))).toBe(false)
    expect(filter(ctx(16, { hostiles: 1 }))).toBe(false)
    expect(filter(ctx(14, { hostiles: 1 }))).toBe(false)
  })

  it('stays quiet for a routine small fall with nothing around', () => {
    prime()
    expect(filter(ctx(17))).toBe(false)
  })

  it('escalates when swarmed by three or more hostiles', () => {
    prime()
    expect(filter(ctx(18, { hostiles: 3 }))).toBe(true)
  })

  it('does not count hostiles beyond the siege radius', () => {
    prime()
    expect(filter(ctx(18, { hostiles: 1, distantHostiles: 5 }))).toBe(false)
  })

  it('escalates on a single heavy hit even with nothing nearby', () => {
    prime()
    expect(filter(ctx(13))).toBe(true) // 7 damage
  })

  it('escalates when a player is the attacker, since the defend reflex never fights players', () => {
    prime()
    expect(filter(ctx(18, { players: 1 }))).toBe(true)
  })

  it('escalates once for standing in lava, not once per tick', () => {
    prime()
    expect(filter(ctx(19, { inLava: true }))).toBe(true)
    expect(filter(ctx(18, { inLava: true }))).toBe(false)
    expect(filter(ctx(17, { inLava: true }))).toBe(false)
    expect(filter(ctx(16, { inLava: true }))).toBe(false)
  })

  it('re-arms after a quiet gap so a later separate incident is reported again', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    prime()
    expect(filter(ctx(19, { inLava: true }))).toBe(true)
    expect(filter(ctx(18, { inLava: true }))).toBe(false)

    // Eleven quiet seconds later, this is a new incident.
    vi.setSystemTime(new Date('2026-01-01T00:00:11Z'))
    expect(filter(ctx(17, { inLava: true }))).toBe(true)
  })

  it('ignores healing and no-change health events', () => {
    prime(10)
    expect(filter(ctx(20))).toBe(false)
    expect(filter(ctx(20))).toBe(false)
  })

  it('reports why it escalated so the brain can pick a strategy', () => {
    prime()
    filter(ctx(18, { hostiles: 4 }))
    const extracted = extract(ctx(18, { hostiles: 4 })) as any

    expect(extracted.escalation).toBe('siege')
    expect(extracted.nearbyHostiles).toBe(4)
    expect(extracted.amount).toBe(2)
  })
})
