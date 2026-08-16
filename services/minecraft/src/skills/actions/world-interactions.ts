import type { Bot } from 'mineflayer'
import type { Entity } from 'prismarine-entity'

import type { Mineflayer } from '../../libs/mineflayer'
import type { SkillResult } from '../base'

import pathfinder from 'mineflayer-pathfinder'

import { sleep } from '@moeru/std'

import { useLogger } from '../../utils/logger'
import { skillFail, skillOk } from '../base'
import { patchedGoto } from '../patched-goto'

const logger = useLogger()

// NOTICE: this file used to carry near-duplicate copies of `placeBlock`, `breakBlockAt`,
// `activateNearestBlock` and `tillAndSow` that shadowed the ones in `skills/blocks.ts`. Both sets
// were live at once — `cognitive/action/llm-actions.ts` imported these, `skills/crafting.ts`
// imported those — so the bot behaved differently depending on the call path. The copies here were
// the weaker ones (no cheats/creative fast paths, no block-state handling for torches/stairs, and
// they threw `ActionError`, whose code/context the sandbox discards). They have been deleted;
// `skills/blocks.ts` is now the single implementation. Only `pickupNearbyItems`, which never had a
// counterpart, remains.

/**
 * Pick up nearby items.
 * @param mineflayer The mineflayer instance.
 * @param distance The maximum distance to pick up items. Default is 8.
 */
export async function pickupNearbyItems(
  mineflayer: Mineflayer,
  distance = 8,
): Promise<SkillResult> {
  const getNearestItem = (bot: Bot): Entity | null =>
    bot.nearestEntity(
      entity =>
        entity.name === 'item'
        && entity.onGround
        && bot.entity.position.distanceTo(entity.position) < distance,
    )
  let nearestItem: Entity | null = getNearestItem(mineflayer.bot)

  if (!nearestItem) {
    logger.log('No dropped items nearby.')
    return skillFail('targetNotFound', `No dropped items on the ground within ${distance} blocks.`, {
      detail: { searchRange: distance },
    })
  }

  let pickedUp = 0
  while (nearestItem) {
    // bot.pathfinder.setMovements(new pf.Movements(bot));
    await patchedGoto(mineflayer.bot, new pathfinder.goals.GoalFollow(nearestItem, 0.8))
    await sleep(500)
    const prev: Entity | null = nearestItem
    nearestItem = getNearestItem(mineflayer.bot)
    if (prev === nearestItem) {
      break
    }
    pickedUp++
  }

  logger.log(`Picked up ${pickedUp} items.`)
  return skillOk(`Picked up ${pickedUp} dropped item stack(s).`, { pickedUp })
}
