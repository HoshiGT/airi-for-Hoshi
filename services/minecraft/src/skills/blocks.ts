import type { Mineflayer } from '../libs/mineflayer'
import type { BlockFace, SkillResult } from './base'

import pathfinderModel from 'mineflayer-pathfinder'

import { sleep } from '@moeru/std'
import { Vec3 } from 'vec3'

import { McData } from '../utils/mcdata'
import { log, skillFail, skillOk } from './base'
import { goToPosition } from './movement'
import { patchedGoto } from './patched-goto'
import { getNearestBlock } from './world'

const { goals, Movements } = pathfinderModel

/**
 * Break a block at the specified position.
 *
 * NOTICE: this is the single surviving implementation. A near-duplicate used to live in
 * `skills/actions/world-interactions.ts`; that copy threw `ActionError` (which the sandbox
 * flattens to a bare string) and lacked the cheats/creative fast paths, so it was removed and its
 * one genuinely better trait — verifying the block is gone and retrying once — was folded in here.
 */
export async function breakBlockAt(
  mineflayer: Mineflayer,
  x: number,
  y: number,
  z: number,
): Promise<SkillResult> {
  if (x == null || y == null || z == null || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return skillFail('invalidPosition', `Invalid position to break block at: (${x}, ${y}, ${z}).`)
  }

  const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  const block = mineflayer.bot.blockAt(pos)
  if (!block) {
    return skillFail('targetNotFound', `No block found at (${pos.x}, ${pos.y}, ${pos.z}) — it may be outside loaded chunks.`, {
      detail: { position: { x: pos.x, y: pos.y, z: pos.z } },
    })
  }

  if (isUnbreakableBlock(block)) {
    return skillFail('notBreakable', `Nothing to break at (${pos.x}, ${pos.y}, ${pos.z}): it is ${block.name}.`, {
      detail: { position: { x: pos.x, y: pos.y, z: pos.z }, blockType: block.name },
    })
  }

  if (mineflayer.allowCheats) {
    return breakWithCheats(mineflayer, pos)
  }

  await moveIntoRange(mineflayer, block)

  const result = mineflayer.isCreative
    ? await breakInCreative(mineflayer, block, pos)
    : await breakInSurvival(mineflayer, block, pos)

  if (!result.ok)
    return result

  return verifyBroken(mineflayer, pos, block.name)
}

/**
 * Confirm the block actually disappeared, retrying the dig once if it did not.
 *
 * Servers occasionally ack a dig that never lands (lag, block-update races). Reporting success in
 * that case makes the model plan on top of a block that is still there, which costs several turns
 * to unwind.
 */
async function verifyBroken(mineflayer: Mineflayer, pos: Vec3, blockName: string): Promise<SkillResult> {
  const after = mineflayer.bot.blockAt(pos)
  if (!after || isUnbreakableBlock(after))
    return skillOk(`Broke ${blockName} at (${pos.x}, ${pos.y}, ${pos.z}).`)

  log(mineflayer, `${blockName} still present at ${pos} after digging, retrying once.`)
  try {
    await mineflayer.bot.lookAt(after.position, true)
    await mineflayer.bot.dig(after, true)
  }
  catch (err) {
    return skillFail('digFailed', `Retry dig of ${blockName} at (${pos.x}, ${pos.y}, ${pos.z}) failed: ${String(err)}.`, {
      detail: { position: { x: pos.x, y: pos.y, z: pos.z }, blockType: blockName },
    })
  }

  const after2 = mineflayer.bot.blockAt(pos)
  if (!after2 || isUnbreakableBlock(after2))
    return skillOk(`Broke ${blockName} at (${pos.x}, ${pos.y}, ${pos.z}).`)

  return skillFail('digFailed', `${blockName} at (${pos.x}, ${pos.y}, ${pos.z}) is still there after two dig attempts.`, {
    detail: { position: { x: pos.x, y: pos.y, z: pos.z }, blockType: blockName },
  })
}

function isUnbreakableBlock(block: any): boolean {
  return block.name === 'air' || block.name === 'water' || block.name === 'lava'
}

async function breakWithCheats(mineflayer: Mineflayer, pos: Vec3): Promise<SkillResult> {
  mineflayer.bot.chat(`/setblock ${pos.x} ${pos.y} ${pos.z} air`)
  log(mineflayer, `Used /setblock to break block at ${pos.x}, ${pos.y}, ${pos.z}.`)
  return skillOk(`Used /setblock to break the block at (${pos.x}, ${pos.y}, ${pos.z}).`)
}

async function moveIntoRange(mineflayer: Mineflayer, block: any) {
  if (mineflayer.bot.entity.position.distanceTo(block.position) > 4.5) {
    const pos = block.position
    const movements = new Movements(mineflayer.bot)
    movements.allowParkour = false
    movements.allowSprinting = false
    mineflayer.bot.pathfinder.setMovements(movements)
    await patchedGoto(mineflayer.bot, new goals.GoalNear(pos.x, pos.y, pos.z, 4))
  }
}

async function breakInCreative(mineflayer: Mineflayer, block: any, pos: Vec3): Promise<SkillResult> {
  try {
    await mineflayer.bot.dig(block, true)
  }
  catch (err) {
    return skillFail('digFailed', `Failed to dig ${block.name} at (${pos.x}, ${pos.y}, ${pos.z}): ${String(err)}.`, {
      detail: { position: { x: pos.x, y: pos.y, z: pos.z }, blockType: block.name },
    })
  }
  log(mineflayer, `Broke ${block.name} at x:${pos.x}, y:${pos.y}, z:${pos.z}.`)
  return skillOk(`Broke ${block.name} at (${pos.x}, ${pos.y}, ${pos.z}).`)
}

async function breakInSurvival(mineflayer: Mineflayer, block: any, pos: Vec3): Promise<SkillResult> {
  await mineflayer.bot.tool.equipForBlock(block)

  const itemId = mineflayer.bot.heldItem?.type
  if (!block.canHarvest(itemId)) {
    log(mineflayer, `Don't have right tools to break ${block.name}.`)
    return skillFail('toolMissing', `No tool in inventory can harvest ${block.name}. Craft or equip the right tool first (e.g. ensurePickaxe for stone/ore).`, {
      missing: [{ item: `tool for ${block.name}`, need: 1, have: 0 }],
      detail: { blockType: block.name, heldItem: mineflayer.bot.heldItem?.name ?? null },
    })
  }

  try {
    await mineflayer.bot.dig(block, true)
  }
  catch (err) {
    return skillFail('digFailed', `Failed to dig ${block.name} at (${pos.x}, ${pos.y}, ${pos.z}): ${String(err)}.`, {
      detail: { position: { x: pos.x, y: pos.y, z: pos.z }, blockType: block.name },
    })
  }

  log(mineflayer, `Broke ${block.name} at x:${pos.x}, y:${pos.y}, z:${pos.z}.`)
  return skillOk(`Broke ${block.name} at (${pos.x}, ${pos.y}, ${pos.z}).`)
}

/**
 * Place a block at the specified position.
 *
 * NOTICE: this is the single surviving implementation. The copy in
 * `skills/actions/world-interactions.ts` was removed — it had no cheats path and no block-state
 * handling (wall_torch conversion, `facing=` for stairs/ladders/repeaters, button/lever `face=`),
 * so placing a torch against a wall silently produced the wrong block.
 */
export async function placeBlock(
  mineflayer: Mineflayer,
  blockType: string,
  x: number,
  y: number,
  z: number,
  placeOn: BlockFace = 'bottom',
  dontCheat = false,
): Promise<SkillResult> {
  const mcData = McData.fromBot(mineflayer.bot)
  if (!mcData.getBlockId(blockType)) {
    log(mineflayer, `Invalid block type: ${blockType}.`)
    return skillFail('invalidBlockType', `"${blockType}" is not a known block type. Use the exact Minecraft id, e.g. "oak_planks", "torch", "crafting_table".`, {
      detail: { blockType },
    })
  }

  const targetDest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))

  if (mineflayer.allowCheats && !dontCheat) {
    return placeWithCheats(mineflayer, blockType, targetDest, placeOn)
  }

  return placeWithoutCheats(mineflayer, blockType, targetDest, placeOn)
}

function getBlockState(blockType: string, placeOn: BlockFace): string {
  const face = getInvertedFace(placeOn as 'north' | 'south' | 'east' | 'west')
  let blockState = blockType

  if (blockType.includes('torch') && placeOn !== 'bottom') {
    blockState = handleTorchState(blockType, placeOn, face)
  }

  if (blockType.includes('button') || blockType === 'lever') {
    blockState = handleButtonLeverState(blockState, placeOn, face)
  }

  if (needsFacingState(blockType)) {
    blockState += `[facing=${face}]`
  }

  return blockState
}

function getInvertedFace(placeOn: BlockFace): string {
  const faceMap: Record<string, string> = {
    north: 'south',
    south: 'north',
    east: 'west',
    west: 'east',
  }

  return faceMap[placeOn] || placeOn
}

function handleTorchState(blockType: string, placeOn: BlockFace, face: string): string {
  let state = blockType.replace('torch', 'wall_torch')
  if (placeOn !== 'side' && placeOn !== 'top') {
    state += `[facing=${face}]`
  }
  return state
}

function handleButtonLeverState(blockState: string, placeOn: BlockFace, face: string): string {
  if (placeOn === 'top') {
    return `${blockState}[face=ceiling]`
  }
  if (placeOn === 'bottom') {
    return `${blockState}[face=floor]`
  }
  return `${blockState}[facing=${face}]`
}

function needsFacingState(blockType: string): boolean {
  return blockType === 'ladder'
    || blockType === 'repeater'
    || blockType === 'comparator'
    || blockType.includes('stairs')
}

async function placeWithCheats(
  mineflayer: Mineflayer,
  blockType: string,
  targetDest: Vec3,
  placeOn: BlockFace,
): Promise<SkillResult> {
  const blockState = getBlockState(blockType, placeOn)

  mineflayer.bot.chat(`/setblock ${targetDest.x} ${targetDest.y} ${targetDest.z} ${blockState}`)

  if (blockType.includes('door')) {
    mineflayer.bot.chat(`/setblock ${targetDest.x} ${targetDest.y + 1} ${targetDest.z} ${blockState}[half=upper]`)
  }

  if (blockType.includes('bed')) {
    mineflayer.bot.chat(`/setblock ${targetDest.x} ${targetDest.y} ${targetDest.z - 1} ${blockState}[part=head]`)
  }

  log(mineflayer, `Used /setblock to place ${blockType} at ${targetDest}.`)
  return skillOk(`Used /setblock to place ${blockType} at (${targetDest.x}, ${targetDest.y}, ${targetDest.z}).`)
}

async function placeWithoutCheats(
  mineflayer: Mineflayer,
  blockType: string,
  targetDest: Vec3,
  placeOn: BlockFace,
): Promise<SkillResult> {
  const itemName = blockType === 'redstone_wire' ? 'redstone' : blockType

  let block = mineflayer.bot.inventory.items().find(item => item.name === itemName)
  if (!block && mineflayer.isCreative) {
    const mcData = McData.fromBot(mineflayer.bot)
    const itemId = mcData.getItemId(itemName)
    if (itemId) {
      const item = await import('prismarine-item')
      const Item = item.default(mineflayer.bot.version)
      await mineflayer.bot.creative.setInventorySlot(36, new Item(itemId, 1))
    }
    block = mineflayer.bot.inventory.items().find(item => item.name === itemName)
  }

  if (!block) {
    log(mineflayer, `Don't have any ${blockType} to place.`)
    return skillFail('itemMissing', `No ${itemName} in inventory to place. Craft or collect one first.`, {
      missing: [{ item: itemName, need: 1, have: 0 }],
      detail: { blockType },
    })
  }

  const targetBlock = mineflayer.bot.blockAt(targetDest)
  if (targetBlock?.name === blockType) {
    log(mineflayer, `${blockType} already at ${targetBlock.position}.`)
    return skillOk(`${blockType} is already at (${targetDest.x}, ${targetDest.y}, ${targetDest.z}); nothing to do.`, {
      alreadyPresent: true,
    })
  }

  const emptyBlocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern']
  if (!emptyBlocks.includes(targetBlock?.name ?? '')) {
    const cleared = await clearBlockSpace(mineflayer, targetBlock, blockType)
    if (!cleared.ok)
      return cleared
  }

  const { buildOffBlock, faceVec } = findPlacementSpot(mineflayer, targetDest, placeOn, emptyBlocks)
  if (!buildOffBlock || !faceVec) {
    log(mineflayer, `Cannot place ${blockType} at ${targetBlock?.position}: nothing to place on.`)
    return skillFail('noSupport', `Cannot place ${blockType} at (${targetDest.x}, ${targetDest.y}, ${targetDest.z}): every adjacent position is empty, so there is no surface to build off. Place a support block next to it first.`, {
      detail: { blockType, position: { x: targetDest.x, y: targetDest.y, z: targetDest.z } },
    })
  }

  await moveIntoPosition(mineflayer, blockType, targetBlock)
  return await tryPlaceBlock(mineflayer, block, buildOffBlock, faceVec, blockType, targetDest)
}

async function clearBlockSpace(
  mineflayer: Mineflayer,
  targetBlock: any,
  blockType: string,
): Promise<SkillResult> {
  const removed = await breakBlockAt(mineflayer, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z)
  if (!removed.ok) {
    log(mineflayer, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`)
    return skillFail('obstructed', `Cannot place ${blockType} at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z}): ${targetBlock.name} is in the way and could not be broken — ${removed.message}`, {
      missing: removed.missing,
      detail: { blockType, obstruction: targetBlock.name, breakReason: removed.reason },
    })
  }
  await sleep(200)
  return skillOk('Cleared the space.')
}

function findPlacementSpot(mineflayer: Mineflayer, targetDest: Vec3, placeOn: BlockFace, emptyBlocks: string[]) {
  const dirMap = {
    top: new Vec3(0, 1, 0),
    bottom: new Vec3(0, -1, 0),
    north: new Vec3(0, 0, -1),
    south: new Vec3(0, 0, 1),
    east: new Vec3(1, 0, 0),
    west: new Vec3(-1, 0, 0),
  }

  const dirs = getPlacementDirections(placeOn, dirMap)

  for (const d of dirs) {
    const block = mineflayer.bot.blockAt(targetDest.plus(d))
    if (!emptyBlocks.includes(block?.name ?? '')) {
      return {
        buildOffBlock: block,
        faceVec: new Vec3(-d.x, -d.y, -d.z),
      }
    }
  }

  return { buildOffBlock: null, faceVec: null }
}

function getPlacementDirections(placeOn: BlockFace, dirMap: Record<string, Vec3>): Vec3[] {
  const directions: Vec3[] = []
  if (placeOn === 'side') {
    directions.push(dirMap.north, dirMap.south, dirMap.east, dirMap.west)
  }
  else if (dirMap[placeOn]) {
    directions.push(dirMap[placeOn])
  }
  else {
    directions.push(dirMap.bottom)
  }

  directions.push(...Object.values(dirMap).filter(d => !directions.includes(d)))
  return directions
}

async function moveIntoPosition(mineflayer: Mineflayer, blockType: string, targetBlock: any) {
  const dontMoveFor = [
    'torch',
    'redstone_torch',
    'redstone_wire',
    'lever',
    'button',
    'rail',
    'detector_rail',
    'powered_rail',
    'activator_rail',
    'tripwire_hook',
    'tripwire',
    'water_bucket',
  ]

  const pos = mineflayer.bot.entity.position
  const posAbove = pos.plus(new Vec3(0, 1, 0))

  if (!dontMoveFor.includes(blockType)
    && (pos.distanceTo(targetBlock.position) < 1
      || posAbove.distanceTo(targetBlock.position) < 1)) {
    await moveAwayFromBlock(mineflayer, targetBlock)
  }

  if (mineflayer.bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
    await moveToBlock(mineflayer, targetBlock)
  }
}

async function moveAwayFromBlock(mineflayer: Mineflayer, targetBlock: any) {
  const goal = new goals.GoalNear(
    targetBlock.position.x,
    targetBlock.position.y,
    targetBlock.position.z,
    2,
  )
  const invertedGoal = new goals.GoalInvert(goal)
  mineflayer.bot.pathfinder.setMovements(new Movements(mineflayer.bot))
  await patchedGoto(mineflayer.bot, invertedGoal)
}

async function moveToBlock(mineflayer: Mineflayer, targetBlock: any) {
  const pos = targetBlock.position
  const movements = new Movements(mineflayer.bot)
  mineflayer.bot.pathfinder.setMovements(movements)
  await patchedGoto(mineflayer.bot, new goals.GoalNear(pos.x, pos.y, pos.z, 4))
}

async function tryPlaceBlock(
  mineflayer: Mineflayer,
  block: any,
  buildOffBlock: any,
  faceVec: Vec3,
  blockType: string,
  targetDest: Vec3,
): Promise<SkillResult> {
  await mineflayer.bot.equip(block, 'hand')
  await mineflayer.bot.lookAt(buildOffBlock.position)

  try {
    await mineflayer.bot.placeBlock(buildOffBlock, faceVec)
    log(mineflayer, `Placed ${blockType} at ${targetDest}.`)
    await sleep(200)
    return skillOk(`Placed ${blockType} at (${targetDest.x}, ${targetDest.y}, ${targetDest.z}).`)
  }
  catch (err) {
    log(mineflayer, `Failed to place ${blockType} at ${targetDest}.`)
    return skillFail('placementRejected', `The server rejected placing ${blockType} at (${targetDest.x}, ${targetDest.y}, ${targetDest.z}): ${String(err)}. The spot may be occupied by an entity, or out of reach.`, {
      detail: { blockType, position: { x: targetDest.x, y: targetDest.y, z: targetDest.z } },
    })
  }
}

/**
 * Use a door at the specified position
 */
export async function useDoor(mineflayer: Mineflayer, doorPos: Vec3 | null = null): Promise<SkillResult> {
  doorPos = doorPos || await findNearestDoor(mineflayer)

  if (!doorPos) {
    log(mineflayer, 'Could not find a door to use.')
    return skillFail('targetNotFound', 'No door found within 16 blocks.')
  }

  const arrival = await goToPosition(mineflayer, doorPos.x, doorPos.y, doorPos.z, 1)
  if (!arrival.ok) {
    return skillFail('navigationFailed', `Could not reach the door at (${doorPos.x}, ${doorPos.y}, ${doorPos.z}): ${arrival.reason} — ${arrival.message}`, {
      detail: { position: { x: doorPos.x, y: doorPos.y, z: doorPos.z } },
    })
  }

  while (mineflayer.bot.pathfinder.isMoving()) {
    await sleep(100)
  }

  return await operateDoor(mineflayer, doorPos)
}

async function findNearestDoor(mineflayer: Mineflayer): Promise<Vec3 | null> {
  const doorTypes = [
    'oak_door',
    'spruce_door',
    'birch_door',
    'jungle_door',
    'acacia_door',
    'dark_oak_door',
    'mangrove_door',
    'cherry_door',
    'bamboo_door',
    'crimson_door',
    'warped_door',
  ]

  // NOTICE: this used to be handed the raw `bot`, but `getNearestBlock` expects the Mineflayer
  // wrapper — every lookup silently failed, so `useDoor` could never find a door on its own.
  for (const doorType of doorTypes) {
    const block = getNearestBlock(mineflayer, doorType, 16)
    if (block) {
      return block.position
    }
  }
  return null
}

async function operateDoor(mineflayer: Mineflayer, doorPos: Vec3): Promise<SkillResult> {
  const doorBlock = mineflayer.bot.blockAt(doorPos)
  await mineflayer.bot.lookAt(doorPos)

  if (!doorBlock) {
    log(mineflayer, `Cannot find door at ${doorPos}.`)
    return skillFail('targetNotFound', `No door block at (${doorPos.x}, ${doorPos.y}, ${doorPos.z}).`)
  }

  if (!doorBlock.getProperties().open) {
    await mineflayer.bot.activateBlock(doorBlock)
  }

  mineflayer.bot.setControlState('forward', true)
  await sleep(600)
  mineflayer.bot.setControlState('forward', false)
  await mineflayer.bot.activateBlock(doorBlock)

  mineflayer.bot.setControlState('forward', true)
  await sleep(600)
  mineflayer.bot.setControlState('forward', false)
  await mineflayer.bot.activateBlock(doorBlock)

  log(mineflayer, `Used door at ${doorPos}.`)
  return skillOk(`Opened, walked through and closed the door at (${doorPos.x}, ${doorPos.y}, ${doorPos.z}).`)
}

export async function tillAndSow(
  mineflayer: Mineflayer,
  x: number,
  y: number,
  z: number,
  seedType: string | null = null,
): Promise<SkillResult> {
  const pos = { x: Math.round(x), y: Math.round(y), z: Math.round(z) }

  const block = mineflayer.bot.blockAt(new Vec3(pos.x, pos.y, pos.z))

  if (!block) {
    log(mineflayer, `Cannot till, no block at ${JSON.stringify(pos)}.`)
    return skillFail('targetNotFound', `No block at (${pos.x}, ${pos.y}, ${pos.z}) — it may be outside loaded chunks.`, {
      detail: { position: pos },
    })
  }

  if (!canTillBlock(block)) {
    log(mineflayer, `Cannot till ${block.name}, must be grass_block or dirt.`)
    return skillFail('wrongBlockType', `Cannot till ${block.name} at (${pos.x}, ${pos.y}, ${pos.z}): only grass_block, dirt or farmland can be tilled.`, {
      detail: { position: pos, blockType: block.name },
    })
  }

  // NOTICE: `blockAt` returning null here means "chunk not loaded", not "nothing above". Treating
  // that as an obstruction (the old behaviour) made tilling fail at chunk borders for no reason.
  const above = mineflayer.bot.blockAt(new Vec3(pos.x, pos.y + 1, pos.z))
  if (above && !isBlockClear(above)) {
    log(mineflayer, `Cannot till, there is ${above.name} above the block.`)
    return skillFail('obstructed', `Cannot till (${pos.x}, ${pos.y}, ${pos.z}): ${above.name} is sitting on top of it. Break that first.`, {
      detail: { position: pos, obstruction: above.name },
    })
  }

  await moveIntoRange(mineflayer, block)

  const tilled = await tillBlock(mineflayer, block, pos)
  if (!tilled.ok)
    return tilled

  if (seedType) {
    return await sowSeeds(mineflayer, block, seedType, pos)
  }

  return skillOk(`Tilled (${pos.x}, ${pos.y}, ${pos.z}). No seed given, so nothing was planted.`)
}

function canTillBlock(block: any): boolean {
  return block.name === 'grass_block' || block.name === 'dirt' || block.name === 'farmland'
}

function isBlockClear(block: any): boolean {
  return block.name === 'air'
}

async function tillBlock(mineflayer: Mineflayer, block: any, pos: any): Promise<SkillResult> {
  if (block.name === 'farmland') {
    return skillOk('Already farmland.')
  }

  const hoe = mineflayer.bot.inventory.items().find(item => item.name.includes('hoe'))
  if (!hoe) {
    log(mineflayer, 'Cannot till, no hoes.')
    return skillFail('itemMissing', 'No hoe in inventory. Call ensureHoe first.', {
      missing: [{ item: 'hoe', need: 1, have: 0 }],
    })
  }

  await mineflayer.bot.equip(hoe, 'hand')
  await mineflayer.bot.activateBlock(block)
  log(mineflayer, `Tilled block x:${pos.x}, y:${pos.y}, z:${pos.z}.`)
  return skillOk(`Tilled (${pos.x}, ${pos.y}, ${pos.z}).`)
}

async function sowSeeds(mineflayer: Mineflayer, block: any, seedType: string, pos: any): Promise<SkillResult> {
  seedType = fixSeedName(seedType)

  // NOTICE: substring match, not equality. The model routinely asks for "wheat" or "beetroot" when
  // the item is `wheat_seeds` / `beetroot_seeds`; an exact match rejected those and burned a turn.
  const seeds = mineflayer.bot.inventory
    .items()
    .find(item => item.name === seedType || item.name.includes(seedType))
  if (!seeds) {
    log(mineflayer, `No ${seedType} to plant.`)
    return skillFail('itemMissing', `Tilled (${pos.x}, ${pos.y}, ${pos.z}) but there is no ${seedType} in inventory to plant.`, {
      missing: [{ item: seedType, need: 1, have: 0 }],
      detail: { position: pos, tilled: true },
    })
  }

  await mineflayer.bot.equip(seeds, 'hand')
  await mineflayer.bot.placeBlock(block, new Vec3(0, -1, 0))
  log(mineflayer, `Planted ${seeds.name} at x:${pos.x}, y:${pos.y}, z:${pos.z}.`)
  return skillOk(`Tilled (${pos.x}, ${pos.y}, ${pos.z}) and planted ${seeds.name}.`)
}

function fixSeedName(seedType: string): string {
  if (seedType.endsWith('seed') && !seedType.endsWith('seeds')) {
    return `${seedType}s` // Fix common mistake
  }
  return seedType
}

export async function activateNearestBlock(mineflayer: Mineflayer, type: string): Promise<SkillResult> {
  const block = getNearestBlock(mineflayer, type, 16)
  if (!block) {
    log(mineflayer, `Could not find any ${type} to activate.`)
    return skillFail('targetNotFound', `No ${type} found within 16 blocks to activate.`, {
      detail: { blockType: type, searchRange: 16 },
    })
  }

  await moveIntoRange(mineflayer, block)

  try {
    await mineflayer.bot.activateBlock(block)
  }
  catch (err) {
    return skillFail('activationFailed', `Found ${type} at (${block.position.x}, ${block.position.y}, ${block.position.z}) but activating it failed: ${String(err)}.`, {
      detail: { blockType: type, position: { x: block.position.x, y: block.position.y, z: block.position.z } },
    })
  }

  log(mineflayer, `Activated ${type} at x:${block.position.x}, y:${block.position.y}, z:${block.position.z}.`)
  return skillOk(`Activated ${type} at (${block.position.x}, ${block.position.y}, ${block.position.z}).`)
}
