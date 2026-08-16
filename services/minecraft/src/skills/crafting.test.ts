import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ActionError } from '../utils/errors'
import { smeltItem } from './crafting'
import { goToNearestBlock } from './movement'

const mocks = vi.hoisted(() => ({
  collectBlock: vi.fn(),
  getInventoryCounts: vi.fn(),
  getNearestBlock: vi.fn(),
  getNearestFreeSpace: vi.fn(),
  getItemId: vi.fn(),
  getItemName: vi.fn(),
  log: vi.fn(),
  placeBlock: vi.fn(),
}))

vi.mock('../utils/logger', () => ({
  useLogger: () => ({
    log: mocks.log,
    withFields: () => ({ log: mocks.log }),
  }),
}))

vi.mock('../utils/mcdata', () => ({
  McData: {
    fromBot: vi.fn(() => ({
      getItemId: mocks.getItemId,
      getItemName: mocks.getItemName,
    })),
  },
}))

vi.mock('./actions/collect-block', () => ({
  collectBlock: mocks.collectBlock,
}))

vi.mock('./blocks', () => ({
  placeBlock: mocks.placeBlock,
}))

vi.mock('./movement', () => ({
  goToNearestBlock: vi.fn(),
  goToPosition: vi.fn(),
  moveAway: vi.fn(),
}))

vi.mock('./world', () => ({
  getInventoryCounts: mocks.getInventoryCounts,
  getNearestBlock: mocks.getNearestBlock,
  getNearestFreeSpace: mocks.getNearestFreeSpace,
}))

vi.mock('./actions/ensure', () => ({
  ensureCraftingTable: vi.fn(),
}))

vi.mock('../utils/recipe-planner', () => ({
  planRecipe: vi.fn(),
}))

describe('crafting smeltItem', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mocks.getNearestFreeSpace.mockReturnValue({ x: 1, y: 64, z: 1 })
    mocks.getNearestBlock
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        position: {
          x: 1,
          y: 64,
          z: 1,
        },
      })
    mocks.getInventoryCounts.mockReturnValue({ furnace: 1 })
    mocks.getItemId.mockReturnValue(1)
    mocks.getItemName.mockImplementation((type: number) => type === 1 ? 'raw_beef' : 'unknown')
  })

  it('preserves the real smelting error when temporary furnace cleanup fails', async () => {
    mocks.getInventoryCounts
      .mockReturnValueOnce({ furnace: 1 })
      .mockReturnValueOnce({ furnace: 1 })
    mocks.collectBlock.mockRejectedValue(new ActionError('RESOURCE_MISSING', 'cleanup failed'))

    const furnace = {
      fuelItem: vi.fn(() => null),
      inputItem: vi.fn(() => null),
    }

    const mineflayer = {
      bot: {
        entity: {
          position: {
            distanceTo: vi.fn(() => 0),
          },
        },
        inventory: {
          items: vi.fn(() => []),
        },
        lookAt: vi.fn(),
        openFurnace: vi.fn(async () => furnace),
      },
    } as any

    await expect(smeltItem(mineflayer, 'raw_beef', 2)).rejects.toMatchObject({
      code: 'RESOURCE_MISSING',
      message: 'I do not have enough raw_beef to smelt',
    })
    expect(mocks.collectBlock).toHaveBeenCalledWith(mineflayer, 'furnace', 1)
  })

  // ROOT CAUSE:
  //
  // `goToNearestBlock` was changed from "throws on failure" to "returns a SkillResult", but this
  // call site kept ignoring the return value:
  //
  //   if (distanceTo(furnaceBlock.position) > 4)
  //     await goToNearestBlock(mineflayer, 'furnace', 4, 32)
  //
  // An unreachable furnace therefore stopped aborting the smelt. Execution fell through to
  // `openFurnace` on a block up to 32 blocks away, so the failure surfaced as an opaque mineflayer
  // error rather than "I could not get there" — and a furnace placed for this smelt was left behind.
  it('aborts the smelt when the furnace cannot be reached, and takes the placed furnace back', async () => {
    vi.mocked(goToNearestBlock).mockResolvedValueOnce({
      ok: false,
      reason: 'navigationFailed',
      message: 'Found furnace at (1, 64, 1) but could not reach it: timeout — gave up.',
    })

    const mineflayer = {
      bot: {
        entity: {
          // Far enough that walking to the furnace is required.
          position: { distanceTo: vi.fn(() => 12) },
        },
        inventory: { items: vi.fn(() => []) },
        lookAt: vi.fn(),
        openFurnace: vi.fn(),
      },
    } as any

    await expect(smeltItem(mineflayer, 'raw_beef', 2)).rejects.toMatchObject({
      code: 'NAVIGATION_FAILED',
    })

    expect(mineflayer.bot.openFurnace).not.toHaveBeenCalled()
    expect(mocks.collectBlock).toHaveBeenCalledWith(mineflayer, 'furnace', 1)
  })
})
