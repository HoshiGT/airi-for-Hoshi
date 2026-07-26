import { describe, expect, it } from 'vitest'

import { entityMovedEvent } from './entity-moved'

const filter = entityMovedEvent.mineflayer.filter!

function ctx(distance: number | null, self = false): any {
  return {
    maxDistance: 32,
    distanceTo: () => distance,
    isSelf: () => self,
    entityId: () => 'e1',
  }
}

describe('entity_moved filter', () => {
  it('accepts nearby players', () => {
    expect(filter(ctx(10), { type: 'player', username: 'Steve' })).toBe(true)
  })

  it('rejects mobs before they reach the event bus', () => {
    // The only rule consuming entity_moved requires entityType: player
    // (rules/attention/movement.yaml), so admitting mobs here means paying for nanoid, deepFreeze,
    // AsyncLocalStorage and a full rule sweep on every mob movement packet, then discarding it.
    expect(filter(ctx(5), { type: 'mob', name: 'zombie' })).toBe(false)
    expect(filter(ctx(5), { type: 'object', name: 'item' })).toBe(false)
    expect(filter(ctx(5), { type: 'orb' })).toBe(false)
  })

  it('rejects the bot itself', () => {
    expect(filter(ctx(0, true), { type: 'player', username: 'airi-bot' })).toBe(false)
  })

  it('rejects players beyond max distance or at unknown distance', () => {
    expect(filter(ctx(64), { type: 'player', username: 'Steve' })).toBe(false)
    expect(filter(ctx(null), { type: 'player', username: 'Steve' })).toBe(false)
  })

  it('rejects a missing entity', () => {
    expect(filter(ctx(5), null)).toBe(false)
  })
})
