import type { Entity } from 'prismarine-entity'

import type { Mineflayer } from '../libs/mineflayer'
import type { SkillResult } from './base'
import type { PathfindProgressInfo, PathfindResult } from './patched-goto'

import pathfinder from 'mineflayer-pathfinder'

import { errorMessageFrom, sleep } from '@moeru/std'
import { randomInt } from 'es-toolkit'
import { Vec3 } from 'vec3'

import { useLogger } from '../utils/logger'
import { log, skillFail, skillOk } from './base'
import { patchedGoto } from './patched-goto'
import { getNearestBlock, getNearestEntityWhere } from './world'

export type { PathfindProgressInfo, PathfindResult } from './patched-goto'

const logger = useLogger()
const { goals, Movements } = pathfinder

function resetNavigationMovements(mineflayer: Mineflayer): void {
  mineflayer.bot.pathfinder.setMovements(new Movements(mineflayer.bot))
}

export async function goToPosition(
  mineflayer: Mineflayer,
  x: number,
  y: number,
  z: number,
  minDistance = 2,
  options: { onProgress?: (info: PathfindProgressInfo) => void } = {},
): Promise<PathfindResult> {
  if (x == null || y == null || z == null) {
    log(mineflayer, `Missing coordinates, given x:${x} y:${y} z:${z}`)
    return {
      ok: false,
      reason: 'error',
      message: `Missing coordinates, given x:${x} y:${y} z:${z}`,
      startPos: { x: 0, y: 0, z: 0 },
      endPos: { x: 0, y: 0, z: 0 },
      distanceTraveled: 0,
      distanceToTarget: 0,
      elapsedMs: 0,
      estimatedTimeMs: 0,
      pathCost: 0,
    }
  }

  if (mineflayer.allowCheats) {
    mineflayer.bot.chat(`/tp @s ${x} ${y} ${z}`)
    log(mineflayer, `Teleported to ${x}, ${y}, ${z}.`)
    return {
      ok: true,
      reason: 'success',
      message: `Teleported to ${x}, ${y}, ${z}.`,
      startPos: { x: 0, y: 0, z: 0 },
      endPos: { x, y, z },
      distanceTraveled: 0,
      distanceToTarget: 0,
      elapsedMs: 0,
      estimatedTimeMs: 0,
      pathCost: 0,
    }
  }
  const targetBlock = mineflayer.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
  const blockAbove1 = mineflayer.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y) + 1, Math.floor(z)))
  const blockAbove2 = mineflayer.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y) + 2, Math.floor(z)))

  if (targetBlock?.name !== 'air' && blockAbove1?.name === 'air' && blockAbove2?.name === 'air') {
    // Nudge one block up so we don't dig a silly hole in the ground when using the ground block as reference
    y += 1
  }

  resetNavigationMovements(mineflayer)
  const result = await patchedGoto(mineflayer.bot, new goals.GoalNear(x, y, z, minDistance), {
    onProgress: options.onProgress,
  })

  if (result.ok) {
    log(mineflayer, `You have reached ${x}, ${y}, ${z}.`)
  }
  else {
    log(mineflayer, `Navigation to ${x}, ${y}, ${z} ended: ${result.reason} — ${result.message}`)
  }

  return result
}

/**
 * Walk to the nearest block of a given type.
 *
 * NOTICE: this used to return the `Block` and throw a bare `Error` on both "not found" and "could
 * not reach". The sandbox flattens thrown errors to a string, so the model could not tell those two
 * cases apart — and "not found" is the one where retrying is pointless. It now reports both through
 * a `SkillResult`, with the block's coordinates in `detail` so the model can plan from them.
 */
export async function goToNearestBlock(
  mineflayer: Mineflayer,
  blockType: string,
  minDistance = 2,
  range = 64,
): Promise<SkillResult> {
  const MAX_RANGE = 512
  if (range > MAX_RANGE) {
    log(mineflayer, `Maximum search range capped at ${MAX_RANGE}.`)
    range = MAX_RANGE
  }

  const block = getNearestBlock(mineflayer, blockType, range)
  if (!block) {
    log(mineflayer, `Could not find any ${blockType} in ${range} blocks.`)
    return skillFail('targetNotFound', `No ${blockType} within ${range} blocks. Move somewhere else before searching again — retrying from here will find nothing.`, {
      detail: { blockType, searchRange: range },
    })
  }

  const pos = { x: block.position.x, y: block.position.y, z: block.position.z }
  log(mineflayer, `Found ${blockType} at ${block.position}.`)

  const result = await goToPosition(mineflayer, pos.x, pos.y, pos.z, minDistance)
  if (!result.ok) {
    return skillFail('navigationFailed', `Found ${blockType} at (${pos.x}, ${pos.y}, ${pos.z}) but could not reach it: ${result.reason} — ${result.message}`, {
      detail: { blockType, position: pos, pathfinderReason: result.reason },
    })
  }

  return skillOk(`Reached ${blockType} at (${pos.x}, ${pos.y}, ${pos.z}).`, {
    blockType,
    position: pos,
    distanceToTarget: result.distanceToTarget,
  })
}

/**
 * Walk to the nearest entity of a given type.
 *
 * NOTICE: exposing this as a tool is the point of the whole exercise. Without it the model had to
 * hand-write `query.entities().whereName("pig").first().pos.x`, which crashes with an unhelpful
 * "Cannot read properties of undefined" whenever nothing matches — the exact failure that
 * `augmentDecisionError` in `cognitive/conscious/brain.ts` exists to paper over.
 */
export async function goToNearestEntity(
  mineflayer: Mineflayer,
  entityType: string,
  minDistance = 2,
  range = 64,
): Promise<SkillResult> {
  const entity = getNearestEntityWhere(
    mineflayer,
    entity => entity.name === entityType,
    range,
  )

  if (!entity) {
    log(mineflayer, `Could not find any ${entityType} in ${range} blocks.`)
    return skillFail('targetNotFound', `No ${entityType} within ${range} blocks. Move somewhere else or pick a different target — retrying from here will find nothing.`, {
      detail: { entityType, searchRange: range },
    })
  }

  const distance = mineflayer.bot.entity.position.distanceTo(entity.position)
  const pos = { x: entity.position.x, y: entity.position.y, z: entity.position.z }
  log(mineflayer, `Found ${entityType} ${distance} blocks away.`)

  const result = await goToPosition(mineflayer, pos.x, pos.y, pos.z, minDistance)
  if (!result.ok) {
    return skillFail('navigationFailed', `Found ${entityType} ${distance.toFixed(1)} blocks away but could not reach it: ${result.reason} — ${result.message}`, {
      detail: { entityType, position: pos, pathfinderReason: result.reason },
    })
  }

  // Mobs move. Report where it ended up, not where it was when the search ran.
  const endDistance = entity.isValid
    ? mineflayer.bot.entity.position.distanceTo(entity.position)
    : null

  return skillOk(`Reached ${entityType}${endDistance == null ? ' (it has since despawned or died)' : `, now ${endDistance.toFixed(1)} blocks away`}.`, {
    entityType,
    position: pos,
    distanceToTarget: endDistance,
  })
}

export async function goToPlayer(
  mineflayer: Mineflayer,
  username: string,
  distance = 3,
  options: { onProgress?: (info: PathfindProgressInfo) => void } = {},
): Promise<PathfindResult> {
  if (mineflayer.allowCheats) {
    mineflayer.bot.chat(`/tp @s ${username}`)
    log(mineflayer, `Teleported to ${username}.`)
    return {
      ok: true,
      reason: 'success',
      message: `Teleported to ${username}.`,
      startPos: { x: 0, y: 0, z: 0 },
      endPos: { x: 0, y: 0, z: 0 },
      distanceTraveled: 0,
      distanceToTarget: 0,
      elapsedMs: 0,
      estimatedTimeMs: 0,
      pathCost: 0,
    }
  }

  const player = mineflayer.bot.players[username]?.entity
  if (!player) {
    log(mineflayer, `Could not find ${username}.`)
    return {
      ok: false,
      reason: 'error',
      message: `Could not find ${username}.`,
      startPos: { x: 0, y: 0, z: 0 },
      endPos: { x: 0, y: 0, z: 0 },
      distanceTraveled: 0,
      distanceToTarget: 0,
      elapsedMs: 0,
      estimatedTimeMs: 0,
      pathCost: 0,
    }
  }

  resetNavigationMovements(mineflayer)
  const result = await patchedGoto(mineflayer.bot, new goals.GoalFollow(player, distance), {
    onProgress: options.onProgress,
  })

  if (result.ok) {
    log(mineflayer, `You have reached ${username}.`)
  }
  else {
    log(mineflayer, `Navigation to ${username} ended: ${result.reason} — ${result.message}`)
  }

  return result
}

export async function followPlayer(
  mineflayer: Mineflayer,
  username: string,
  distance = 4,
): Promise<boolean> {
  const player = mineflayer.bot.players[username]?.entity
  if (!player) {
    return false
  }

  log(mineflayer, `I am now actively following player ${username}.`)

  const movements = new Movements(mineflayer.bot)
  mineflayer.bot.pathfinder.setMovements(movements)
  mineflayer.bot.pathfinder.setGoal(new goals.GoalFollow(player, distance), true)

  mineflayer.once('interrupt', () => {
    mineflayer.bot.pathfinder.stop()
  })

  return true
}

export async function moveAway(mineflayer: Mineflayer, distance: number): Promise<SkillResult> {
  const startPos = mineflayer.bot.entity.position.clone()

  try {
    let newX = 0
    let newZ = 0
    let suitableGoal = false

    // NOTICE: bounded. The loop used to spin forever with no exit when every sampled destination
    // landed on water/lava (standing in the middle of an ocean, say), hanging the turn.
    const MAX_SAMPLES = 32
    for (let attempt = 0; attempt < MAX_SAMPLES && !suitableGoal; attempt++) {
      const rand1 = randomInt(0, 2)
      const rand2 = randomInt(0, 2)
      const bigRand1 = randomInt(0, 101)
      const bigRand2 = randomInt(0, 101)

      newX = Math.floor(startPos.x + ((distance * bigRand1) / 100) * (rand1 ? 1 : -1))
      newZ = Math.floor(startPos.z + ((distance * bigRand2) / 100) * (rand2 ? 1 : -1))

      const block = mineflayer.bot.blockAt(new Vec3(newX, startPos.y - 1, newZ))

      if (block?.name !== 'water' && block?.name !== 'lava') {
        suitableGoal = true
      }
    }

    if (!suitableGoal) {
      return skillFail('noDestination', `Could not find dry ground within ${distance} blocks to move to — everything around is water or lava.`, {
        detail: { distance },
      })
    }

    const farGoal = new pathfinder.goals.GoalXZ(newX, newZ)

    const result = await patchedGoto(mineflayer.bot, farGoal)
    const newPos = mineflayer.bot.entity.position
    logger.log(`I moved away from nearest entity to ${newPos}.`)
    await sleep(500)

    const moved = startPos.distanceTo(mineflayer.bot.entity.position)
    if (!result.ok) {
      return skillFail('navigationFailed', `Tried to move ${distance} blocks away but only got ${moved.toFixed(1)} blocks: ${result.reason} — ${result.message}`, {
        detail: { requestedDistance: distance, movedDistance: moved },
      })
    }

    return skillOk(`Moved ${moved.toFixed(1)} blocks away, now at (${Math.floor(newPos.x)}, ${Math.floor(newPos.y)}, ${Math.floor(newPos.z)}).`, {
      movedDistance: moved,
      position: { x: newPos.x, y: newPos.y, z: newPos.z },
    })
  }
  catch (err) {
    logger.log(`I failed to move away: ${(err as Error).message}`)
    return skillFail('navigationFailed', `Failed to move away: ${errorMessageFrom(err) ?? String(err)}`)
  }
}

export async function moveAwayFromEntity(
  mineflayer: Mineflayer,
  entity: Entity,
  distance = 16,
): Promise<SkillResult> {
  const goal = new goals.GoalFollow(entity, distance)
  const invertedGoal = new goals.GoalInvert(goal)
  const result = await patchedGoto(mineflayer.bot, invertedGoal)

  const label = entity.name ?? entity.username ?? 'entity'
  if (!result.ok) {
    return skillFail('navigationFailed', `Could not retreat ${distance} blocks from ${label}: ${result.reason} — ${result.message}`, {
      detail: { entityType: label, requestedDistance: distance },
    })
  }

  return skillOk(`Backed away from ${label}.`, { entityType: label })
}

/**
 * Stand still for a while.
 *
 * NOTICE: `seconds` is clamped. The original accepted `-1` as "forever", which as an LLM-callable
 * tool means one bad argument wedges the bot until the process restarts.
 */
export async function stay(mineflayer: Mineflayer, seconds = 30): Promise<SkillResult> {
  const MAX_SECONDS = 300
  const requested = seconds
  const clamped = Math.min(Math.max(seconds < 0 ? MAX_SECONDS : seconds, 0), MAX_SECONDS)

  const start = Date.now()

  // Race the wait against an interrupt rather than polling a flag: waiting out the full duration
  // while something urgent is happening (a mob attacking, the master calling) is exactly what the
  // interrupt exists to prevent.
  const interrupted = await new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout>

    const onInterrupt = () => {
      clearTimeout(timer)
      resolve(true)
    }

    timer = setTimeout(() => {
      mineflayer.off('interrupt', onInterrupt)
      resolve(false)
    }, clamped * 1000)

    mineflayer.once('interrupt', onInterrupt)
  })

  const elapsed = (Date.now() - start) / 1000
  log(mineflayer, `I stayed for ${elapsed} seconds.`)

  if (interrupted) {
    return skillOk(`Stayed put for ${elapsed.toFixed(0)}s, then was interrupted.`, {
      elapsedSeconds: elapsed,
      interrupted: true,
    })
  }

  return skillOk(
    requested !== clamped
      ? `Stayed put for ${elapsed.toFixed(0)}s (requested ${requested}s, capped at ${MAX_SECONDS}s).`
      : `Stayed put for ${elapsed.toFixed(0)}s.`,
    { elapsedSeconds: elapsed },
  )
}

export async function goToBed(mineflayer: Mineflayer): Promise<boolean> {
  // Consider several nearby beds, not just the closest. The closest is often already occupied (e.g.
  // the master is lying in it), and mineflayer's bot.sleep throws "the bed is occupied" — we want to
  // fall through to a free bed instead of giving up. `name.includes('bed')` matches every colour
  // variant (white_bed, red_bed, ...); the literal name "bed" does not exist in modern Minecraft.
  const bedPositions = mineflayer.bot.findBlocks({
    matching: block => block.name.includes('bed'),
    maxDistance: 32,
    count: 24,
  })

  if (bedPositions.length === 0) {
    log(mineflayer, 'I could not find a bed to sleep in.')
    return false
  }

  let lastError: string | null = null

  for (const loc of bedPositions) {
    const bed = mineflayer.bot.blockAt(loc)
    if (!bed)
      continue

    // Skip beds already in use (the occupied bedstate, e.g. the master's bed) without walking over.
    const occupied = (bed.getProperties?.() as { occupied?: unknown } | undefined)?.occupied
    if (occupied === true || occupied === 'true')
      continue

    await goToPosition(mineflayer, loc.x, loc.y, loc.z)

    const bedNow = mineflayer.bot.blockAt(loc)
    if (!bedNow)
      continue

    try {
      await mineflayer.bot.sleep(bedNow)
    }
    catch (err) {
      lastError = errorMessageFrom(err) ?? ''
      // Sleeping only works at night / during a thunderstorm — no other bed will help, so stop.
      if (lastError.includes('not night'))
        break
      // Otherwise this bed was occupied/unreachable; try the next nearest one.
      continue
    }

    log(mineflayer, 'I am in bed.')
    while (mineflayer.bot.isSleeping) {
      await sleep(500)
    }
    log(mineflayer, 'I have woken up.')
    return true
  }

  log(mineflayer, `I could not sleep in any nearby bed${lastError ? ` (${lastError})` : ''}.`)
  return false
}
