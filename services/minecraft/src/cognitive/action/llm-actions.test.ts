import { beforeEach, describe, expect, it, vi } from 'vitest'

import { collectBlock } from '../../skills/actions/collect-block'
import { breakBlockAt } from '../../skills/blocks'
import { ActionError } from '../../utils/errors'
import { actionsList } from './llm-actions'

vi.mock('../../skills/actions/collect-block', () => ({
  collectBlock: vi.fn(async () => 1),
}))

vi.mock('../../skills/blocks', () => ({
  activateNearestBlock: vi.fn(async () => ({ ok: true, reason: 'success', message: 'activated' })),
  breakBlockAt: vi.fn(async () => ({ ok: true, reason: 'success', message: 'broke it' })),
  placeBlock: vi.fn(async () => ({ ok: true, reason: 'success', message: 'placed' })),
  tillAndSow: vi.fn(async () => ({ ok: true, reason: 'success', message: 'tilled' })),
  useDoor: vi.fn(async () => ({ ok: true, reason: 'success', message: 'used door' })),
}))

function getMineBlockAtAction() {
  const action = actionsList.find(item => item.name === 'mineBlockAt')
  if (!action)
    throw new Error('mineBlockAt action missing')
  return action
}

describe('llm-actions mineBlockAt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows expected torch when actual block is wall_torch', async () => {
    const mineBlockAtAction = getMineBlockAtAction()
    const mineflayer = {
      bot: {
        blockAt: vi.fn(() => ({ name: 'wall_torch' })),
      },
    } as any

    const perform = mineBlockAtAction.perform(mineflayer)
    const result = await perform(1, 2, 3, 'torch') as any

    expect(result.ok).toBe(true)
    expect(breakBlockAt).toHaveBeenCalledWith(mineflayer, 1, 2, 3)
  })

  it('rejects unrelated expected block types', async () => {
    const mineBlockAtAction = getMineBlockAtAction()
    const mineflayer = {
      bot: {
        blockAt: vi.fn(() => ({ name: 'oak_log' })),
      },
    } as any

    const perform = mineBlockAtAction.perform(mineflayer)
    await expect(perform(1, 2, 3, 'torch')).rejects.toThrow(/Block type mismatch/i)
    expect(breakBlockAt).not.toHaveBeenCalled()
  })

  it('rejects collection-only aliases for exact block validation', async () => {
    const mineBlockAtAction = getMineBlockAtAction()
    const mineflayer = {
      bot: {
        blockAt: vi.fn(() => ({ name: 'grass_block' })),
      },
    } as any

    const perform = mineBlockAtAction.perform(mineflayer)
    await expect(perform(1, 2, 3, 'dirt')).rejects.toThrow(/Block type mismatch/i)
    expect(breakBlockAt).not.toHaveBeenCalled()
  })

  it('exposes skip tool with stable return value', async () => {
    const skipAction = actionsList.find(item => item.name === 'skip')
    expect(skipAction).toBeDefined()

    const perform = skipAction!.perform({} as any)
    expect(perform()).toBe('Skipped turn')
  })

  it('returns the structured breakBlockAt result rather than a fixed success string', async () => {
    vi.mocked(breakBlockAt).mockResolvedValueOnce({
      ok: false,
      reason: 'toolMissing',
      message: 'No tool can harvest obsidian.',
      missing: [{ item: 'tool for obsidian', need: 1, have: 0 }],
    } as any)

    const mineflayer = { bot: { blockAt: vi.fn(() => ({ name: 'obsidian' })) } } as any
    const result = await getMineBlockAtAction().perform(mineflayer)(1, 2, 3) as any

    // A "did not work, and here is what is missing" outcome has to survive to the model; the old
    // code discarded it and reported "Mined block at (1, 2, 3)" regardless.
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('toolMissing')
    expect(result.missing).toHaveLength(1)
  })
})

describe('llm-actions collectBlocks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function collectBlocks(mineflayer: unknown = {}) {
    const action = actionsList.find(item => item.name === 'collectBlocks')
    if (!action)
      throw new Error('collectBlocks action missing')
    return action.perform(mineflayer as never)
  }

  it('reports the haul with a count the model can plan from', async () => {
    vi.mocked(collectBlock).mockResolvedValueOnce(8)

    const result = await collectBlocks()('oak_log', 8) as any

    expect(result.ok).toBe(true)
    expect(result.detail.collected).toBe(8)
    expect(result.detail.requested).toBe(8)
  })

  it('treats a partial haul as success, since the count is what the model needs to decide', async () => {
    vi.mocked(collectBlock).mockResolvedValueOnce(3)

    const result = await collectBlocks()('coal_ore', 10) as any

    expect(result.ok).toBe(true)
    expect(result.detail.collected).toBe(3)
    expect(result.message).toContain('3')
    expect(result.message).toContain('10')
  })

  it('turns an empty haul into targetNotFound rather than a thrown string', async () => {
    vi.mocked(collectBlock).mockResolvedValueOnce(0)

    const result = await collectBlocks()('diamond_ore', 1) as any

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('targetNotFound')
    // Retrying in place cannot work, so the recovery has to be spelled out.
    expect(result.message).toContain('moveAway')
  })

  // ROOT CAUSE:
  //
  // `collectBlocks` kept throwing `ActionError` after every other world-mutating tool had moved to
  // `SkillResult`. `js-planner.ts` catches tool throws and keeps only `errorMessageFrom(error)`, so
  // the `missing` list assembled by `breakBlockAt` was flattened to prose and lost:
  //
  //   throw new ActionError('RESOURCE_MISSING', `Failed to collect any ${type}`, ...)
  //
  // The action now returns the failure, and `missing` is lifted to the top level where the system
  // prompt tells the model to look for it.
  it('preserves the missing-tool list instead of flattening it to a message string', async () => {
    vi.mocked(collectBlock).mockRejectedValueOnce(
      new ActionError('RESOURCE_MISSING', 'No tool can harvest iron_ore.', {
        blockType: 'iron_ore',
        missing: [{ item: 'tool for iron_ore', need: 1, have: 0 }],
      }),
    )

    const result = await collectBlocks()('iron_ore', 4) as any

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('RESOURCE_MISSING')
    expect(result.missing).toEqual([{ item: 'tool for iron_ore', need: 1, have: 0 }])
    expect(result.detail.blockType).toBe('iron_ore')
    expect(result.detail.requested).toBe(4)
  })

  it('lets an interrupt through, since a torn-down turn is control flow and not an outcome', async () => {
    vi.mocked(collectBlock).mockRejectedValueOnce(new ActionError('INTERRUPTED', 'Task interrupted'))

    await expect(collectBlocks()('oak_log', 1)).rejects.toThrow(/interrupted/i)
  })
})

describe('llm-actions exposed surface', () => {
  const names = new Set(actionsList.map(action => action.name))

  it('exposes the navigation tools that replace hand-written coordinate lookups', () => {
    // Without these the model writes `query.entities().whereName("pig").first().pos.x`, which
    // throws an opaque TypeError when nothing matches — the failure augmentDecisionError exists for.
    expect(names.has('goToNearestEntity')).toBe(true)
    expect(names.has('goToNearestBlock')).toBe(true)
  })

  it('exposes the ensure* family so resource prerequisites are one call, not a multi-turn plan', () => {
    for (const name of [
      'ensurePickaxe',
      'ensureSword',
      'ensureAxe',
      'ensureShovel',
      'ensureHoe',
      'ensureCraftingTable',
      'ensureFurnaces',
      'ensureChests',
      'ensureTorches',
      'ensureCampfire',
      'ensurePlanks',
      'ensureSticks',
      'ensureCobblestone',
      'ensureCoal',
    ]) {
      expect(names.has(name), `${name} should be exposed`).toBe(true)
    }
  })

  it('exposes the remaining world-interaction gaps', () => {
    for (const name of ['gatherWood', 'placeBlockAt', 'tillAndSow', 'useDoor', 'pickupNearbyItems', 'moveAway', 'stay', 'organizeInventory']) {
      expect(names.has(name), `${name} should be exposed`).toBe(true)
    }
  })

  it('gives every action a unique name and a described schema', () => {
    expect(names.size).toBe(actionsList.length)

    for (const action of actionsList) {
      expect(action.description.length, `${action.name} needs a description`).toBeGreaterThan(10)
      for (const [key, field] of Object.entries(action.schema.shape)) {
        expect((field as any).description, `${action.name}.${key} needs a description`).toBeTruthy()
      }
    }
  })
})
