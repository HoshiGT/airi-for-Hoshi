import type { Action } from '../../libs/mineflayer'
import type { MissingResource, SkillResult } from '../../skills/base'

import { Vec3 } from 'vec3'
import { z } from 'zod'

import { matchesBlockAlias } from '../../skills/actions/block-type-normalizer'
import { collectBlock } from '../../skills/actions/collect-block'
import {
  ensureAxe,
  ensureCampfire,
  ensureChests,
  ensureCoal,
  ensureCobblestone,
  ensureCraftingTable,
  ensureFurnaces,
  ensureHoe,
  ensurePickaxe,
  ensurePlanks,
  ensureShovel,
  ensureSticks,
  ensureSword,
  ensureTorches,
} from '../../skills/actions/ensure'
import { gatherWood } from '../../skills/actions/gather-wood'
import { discard, equip, organizeInventory, putInChest, takeFromChest } from '../../skills/actions/inventory'
import { pickupNearbyItems } from '../../skills/actions/world-interactions'
import { skillFail, skillOk } from '../../skills/base'
import { activateNearestBlock, breakBlockAt, placeBlock, tillAndSow, useDoor } from '../../skills/blocks'
import { ActionError } from '../../utils/errors'
import { describeRecipePlan } from '../../utils/recipe-planner'

import * as skills from '../../skills'

// Utils
const pad = (str: string): string => `\n${str}\n`

function toCoord(pos: { x: number, y: number, z: number }) {
  return { x: pos.x, y: pos.y, z: pos.z }
}

function cloneVec3(pos: { x: number, y: number, z: number }): Vec3 {
  return new Vec3(pos.x, pos.y, pos.z)
}

/**
 * Run a skill that signals failure by throwing, and hand the model a `SkillResult` instead.
 *
 * NOTICE: the sandbox in `cognitive/conscious/js-planner.ts` catches whatever a tool throws and
 * keeps only `errorMessageFrom(error)` — a bare string. An `ActionError`'s `code` and `context`
 * never reach the model, so "missing 3 cobblestone" arrives as prose it has to re-parse, if at all.
 * Wrapping the call converts that into structured data the model can branch on.
 *
 * Interrupts are deliberately re-thrown: they are control flow, not a skill outcome, and
 * `TaskExecutor` relies on seeing them (`cognitive/action/task-executor.ts`).
 */
async function structured(
  successMessage: string,
  fn: () => Promise<unknown>,
  detail?: Record<string, unknown>,
): Promise<SkillResult> {
  try {
    const raw = await fn()

    // Skills already migrated to SkillResult pass theirs straight through.
    if (isSkillResult(raw))
      return raw

    // The legacy convention: `false` means "did not happen", without saying why.
    if (raw === false)
      return skillFail('failed', `${successMessage} — did not succeed, and the skill gave no reason.`, { detail })

    return skillOk(successMessage, detail)
  }
  catch (error) {
    return skillResultFromError(error, detail)
  }
}

/**
 * Translate a thrown skill failure into a `SkillResult`, or rethrow if it is not one.
 *
 * Splits control flow from outcomes: an interrupt means the turn is being torn down and must reach
 * `TaskExecutor`, and anything that is not an `ActionError` is a genuine defect that should surface
 * as one rather than be reported to the model as a tidy failure.
 */
function skillResultFromError(error: unknown, detail?: Record<string, unknown>): SkillResult {
  if (!(error instanceof ActionError))
    throw error

  if (error.code === 'INTERRUPTED')
    throw error

  // `missing` is lifted out of the error's context rather than left inside `detail`: the system
  // prompt tells the model that this exact field lists what it is short of, and burying it one level
  // deeper would quietly break the contract the model was given.
  const { missing, ...context } = error.context ?? {}

  return skillFail(error.code, error.message, {
    missing: isMissingResources(missing) ? missing : undefined,
    detail: { ...detail, ...context },
  })
}

/** `ActionError.context` is untyped, so the shape has to be checked before it is trusted. */
function isMissingResources(value: unknown): value is MissingResource[] {
  return Array.isArray(value)
    && value.every(entry => typeof entry === 'object' && entry !== null && 'item' in entry)
}

function isSkillResult(value: unknown): value is SkillResult {
  return typeof value === 'object'
    && value !== null
    && typeof (value as SkillResult).ok === 'boolean'
    && typeof (value as SkillResult).reason === 'string'
    && typeof (value as SkillResult).message === 'string'
}

/**
 * Shared schema for the `ensure*` family: "make sure I have N of this, crafting/gathering if needed".
 */
const quantitySchema = z.object({
  quantity: z.number().int().min(1).max(64).default(1).describe('How many you need in total (not how many to add).'),
})

export const actionsList: Action[] = [
  {
    name: 'chat',
    description: 'Send a chat message to players in the game. Use this to communicate, respond to questions, or announce what you are doing.',
    execution: 'sync',
    schema: z.object({
      message: z.string().describe('The message to send in chat.'),
      feedback: z.boolean().default(false).describe('Whether to emit FEEDBACK for this chat action. Keep false for normal conversation to avoid feedback loops.'),
    }),
    perform: mineflayer => (message: string): string => {
      mineflayer.bot.chat(message)
      return `Sent message: "${message}"`
    },
  },
  {
    name: 'giveUp',
    description: 'Admit you are currently stuck and halt all autonomous processing until a player speaks to you again.',
    execution: 'sync',
    schema: z.object({
      reason: z.string().min(1).describe('Short explanation of why you are stuck.'),
    }),
    perform: () => (reason: string): string => `Gave up: ${reason}. Halted until player input.`,
  },
  {
    name: 'skip',
    description: 'Skip this turn without performing any world action.',
    execution: 'sync',
    schema: z.object({}),
    perform: () => (): string => 'Skipped turn',
  },
  {
    name: 'stop',
    description: 'Force stop all actions', // TODO: include name of the current action in description?
    execution: 'async',
    schema: z.object({}),
    perform: mineflayer => async () => {
      mineflayer.interrupt('stop tool called')

      return 'all actions stopped'
    },
  },
  {
    name: 'goToPlayer',
    description: 'Go to the given player.',
    execution: 'async',
    schema: z.object({
      player_name: z.string().describe('The name of the player to go to.'),
      closeness: z.number().describe('How close to get to the player in blocks.').min(0),
    }),
    perform: mineflayer => async (player_name: string, closeness: number) => {
      const getPlayerPos = () => {
        const entity = mineflayer.bot.players[player_name]?.entity
        return entity ? cloneVec3(entity.position) : null
      }

      const selfStart = cloneVec3(mineflayer.bot.entity.position)
      const targetStart = getPlayerPos()
      const distanceToTargetBefore = targetStart ? selfStart.distanceTo(targetStart) : null

      const result = await skills.goToPlayer(mineflayer, player_name, closeness)

      const selfEnd = cloneVec3(mineflayer.bot.entity.position)
      const targetEnd = getPlayerPos()
      const distanceToTargetAfter = targetEnd ? selfEnd.distanceTo(targetEnd) : null

      return {
        ok: result.ok,
        reason: result.reason,
        target: { player_name, closeness },
        startPos: toCoord(selfStart),
        endPos: toCoord(selfEnd),
        movedDistance: selfStart.distanceTo(selfEnd),
        distanceToTargetBefore,
        distanceToTargetAfter,
        elapsedMs: result.elapsedMs,
        estimatedTimeMs: result.estimatedTimeMs,
        message: result.message,
      }
    },
  },
  {
    name: 'followPlayer',
    description: 'Set idle auto-follow target handled by reflex runtime. While idle, the bot will keep following this player until cleared.',
    execution: 'sync',
    readonly: true,
    schema: z.object({
      player_name: z.string().describe('name of the player to follow.'),
      follow_dist: z.number().describe('The distance to follow from.').min(0),
    }),
    perform: mineflayer => (player_name: string, follow_dist: number) => {
      const reflexManager = (mineflayer as any).reflexManager
      if (!reflexManager || typeof reflexManager.setFollowTarget !== 'function')
        throw new Error('Reflex follow manager is unavailable')

      reflexManager.setFollowTarget(player_name, follow_dist)
      return `Auto-follow enabled for player [${player_name}] at distance ${follow_dist}`
    },
  },
  {
    name: 'clearFollowTarget',
    description: 'Disable idle auto-follow. Use this before independent exploration or when you no longer want to shadow a player.',
    execution: 'sync',
    readonly: true,
    schema: z.object({}),
    perform: mineflayer => () => {
      const reflexManager = (mineflayer as any).reflexManager
      if (!reflexManager || typeof reflexManager.clearFollowTarget !== 'function')
        throw new Error('Reflex follow manager is unavailable')

      reflexManager.clearFollowTarget()
      return 'Auto-follow disabled'
    },
  },
  {
    name: 'goToCoordinate',
    description: 'Go to the given x, y, z location. Uses full A* pathfinding that automatically breaks/digs blocks in the way. Do NOT manually mine-then-move block by block; just call this with the destination.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      x: z.number().describe('The x coordinate.'),
      y: z.number().describe('The y coordinate.').min(-64).max(320),
      z: z.number().describe('The z coordinate.'),
      closeness: z.number().describe('0 If want to be exactly at the position, otherwise a positive number in blocks for leniency.').min(0),
    }),
    perform: mineflayer => async (x: number, y: number, z: number, closeness: number) => {
      const selfStart = cloneVec3(mineflayer.bot.entity.position)
      const targetVec = new Vec3(x, y, z)
      const distanceToTargetBefore = selfStart.distanceTo(targetVec)

      const result = await skills.goToPosition(mineflayer, x, y, z, closeness)

      const selfEnd = cloneVec3(mineflayer.bot.entity.position)
      const distanceToTargetAfter = selfEnd.distanceTo(targetVec)

      return {
        ok: result.ok,
        reason: result.reason,
        target: { x, y, z, closeness },
        startPos: toCoord(selfStart),
        endPos: toCoord(selfEnd),
        movedDistance: selfStart.distanceTo(selfEnd),
        distanceToTargetBefore,
        distanceToTargetAfter,
        withinCloseness: distanceToTargetAfter <= closeness,
        elapsedMs: result.elapsedMs,
        estimatedTimeMs: result.estimatedTimeMs,
        message: result.message,
      }
    },
  },
  {
    name: 'givePlayer',
    description: 'Give the specified item to the given player.',
    execution: 'async',
    schema: z.object({
      player_name: z.string().describe('The name of the player to give the item to.'),
      item_name: z.string().describe('The name of the item to give.'),
      num: z.number().int().describe('The number of items to give.').min(1),
    }),
    perform: mineflayer => async (player_name: string, item_name: string, num: number) => {
      await skills.giveToPlayer(mineflayer, item_name, player_name, num)
      return `Gave [${item_name}]x${num} to player [${player_name}]`
    },
  },
  {
    name: 'consume',
    description: 'Eat/drink the given item.',
    execution: 'async',
    schema: z.object({
      item_name: z.string().describe('The name of the item to consume.'),
    }),
    perform: mineflayer => async (item_name: string) => {
      await skills.consume(mineflayer, item_name)
      return `Consumed [${item_name}]`
    },
  },
  {
    name: 'equip',
    description: 'Equip the given item.',
    execution: 'async',
    schema: z.object({
      item_name: z.string().describe('The name of the item to equip.'),
    }),
    perform: mineflayer => async (item_name: string) => {
      await equip(mineflayer, item_name)
      return `Equipped [${item_name}]`
    },
  },
  {
    name: 'putInChest',
    description: 'Put the given item in the nearest chest.',
    execution: 'async',
    schema: z.object({
      item_name: z.string().describe('The name of the item to put in the chest.'),
      num: z.number().int().describe('The number of items to put in the chest.').min(1),
    }),
    perform: mineflayer => async (item_name: string, num: number) => {
      await putInChest(mineflayer, item_name, num)
      return `Put [${item_name}]x${num} in chest`
    },
  },
  {
    name: 'takeFromChest',
    description: 'Take the given items from the nearest chest.',
    execution: 'async',
    schema: z.object({
      item_name: z.string().describe('The name of the item to take.'),
      num: z.number().int().describe('The number of items to take.').min(1),
    }),
    perform: mineflayer => async (item_name: string, num: number) => {
      await takeFromChest(mineflayer, item_name, num)
      return `Took [${item_name}]x${num} from chest`
    },
  },
  {
    name: 'discard',
    description: 'Discard the given item from the inventory.',
    execution: 'async',
    schema: z.object({
      item_name: z.string().describe('The name of the item to discard.'),
      num: z.number().int().describe('The number of items to discard.').min(1),
    }),
    perform: mineflayer => async (item_name: string, num: number) => {
      await discard(mineflayer, item_name, num)
      return `Discarded [${item_name}]x${num}`
    },
  },
  {
    name: 'collectBlocks',
    description: 'Automatically collect the nearest blocks of a given type.',
    execution: 'async',
    // NOTICE: detach auto-follow before mining. The idle auto-follow reflex drives the same
    // mineflayer pathfinder as digging; if left attached it periodically re-points the bot at the
    // followed player, which both cancels navigation to the ore ("Path was stopped") and aborts the
    // in-progress bot.dig ("Digging aborted"), producing the stutter of repeated half-digs.
    followControl: 'detach',
    schema: z.object({
      type: z.string().describe('The block type to collect.'),
      num: z.number().int().describe('The number of blocks to collect.').min(1),
    }),
    perform: mineflayer => async (type: string, num: number) => {
      try {
        const collected = await collectBlock(mineflayer, type, num)
        if (collected <= 0) {
          return skillFail('targetNotFound', `Found no ${type} to collect within range. Retrying from the same spot will find nothing — call moveAway first, or pick a different block.`, {
            detail: { blockType: type, requested: num, collected: 0 },
          })
        }

        // A partial haul is a success, not an error: the model needs the count to decide whether to
        // keep going, and reporting it as a failure would hide how far it actually got.
        return skillOk(
          collected < num
            ? `Collected ${type} x${collected} of the ${num} requested; nothing more within range.`
            : `Collected ${type} x${collected}.`,
          { blockType: type, requested: num, collected },
        )
      }
      catch (error) {
        // `collectBlock` throws RESOURCE_MISSING when no tool can harvest the vein — the one case
        // where `missing` tells the model exactly which ensure* call fixes it.
        return skillResultFromError(error, { blockType: type, requested: num })
      }
    },
  },
  {
    name: 'mineBlockAt',
    description: 'Mine (break) a block at a specific position. Do NOT use this for regular resource collection. Use collectBlocks instead.',
    execution: 'async',
    // NOTICE: detach auto-follow before mining (same reason as collectBlocks) so the follow reflex
    // cannot interrupt bot.dig mid-break.
    followControl: 'detach',
    schema: z.object({
      x: z.number().describe('The x coordinate.'),
      y: z.number().describe('The y coordinate.'),
      z: z.number().describe('The z coordinate.'),
      expected_block_type: z.string().optional().describe('Optional: expected block type at the position (e.g. oak_log). If provided and mismatched, the action fails.'),
    }),
    perform: mineflayer => async (x: number, y: number, z: number, expected_block_type?: string) => {
      const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
      if (expected_block_type) {
        const block = mineflayer.bot.blockAt(pos)
        if (!block) {
          throw new ActionError('TARGET_NOT_FOUND', `No block found at ${pos}`, { position: pos })
        }

        if (!matchesBlockAlias(expected_block_type, block.name)) {
          throw new ActionError('UNKNOWN', `Block type mismatch at ${pos}: expected ${expected_block_type}, got ${block.name}`, {
            position: pos,
            expected: expected_block_type,
            actual: block.name,
          })
        }
      }

      return await breakBlockAt(mineflayer, pos.x, pos.y, pos.z)
    },
  },
  {
    name: 'craftRecipe',
    description: 'Craft an item. Automatically finds or places a crafting table if needed, and handles intermediate materials for basic items (planks, sticks). Use recipePlan first to check required materials for complex items.',
    execution: 'async',
    schema: z.object({
      recipe_name: z.string().describe('The name of the output item to craft.'),
      num: z.number().int().describe('The number of times to execute the recipe (craft count, NOT output item count). E.g. crafting planks once yields 4 planks, so num=2 yields 8 planks.').min(1),
    }),
    perform: mineflayer => async (recipe_name: string, num: number) => {
      await skills.craftRecipe(mineflayer, recipe_name, num)
      return `Crafted [${recipe_name}] ${num} time(s)`
    },
  },
  {
    name: 'smeltItem',
    description: 'Smelt the given item the given number of times.',
    execution: 'async',
    schema: z.object({
      item_name: z.string().describe('The name of the input item to smelt.'),
      num: z.number().int().describe('The number of times to smelt the item.').min(1),
    }),
    perform: mineflayer => async (item_name: string, num: number) => {
      await skills.smeltItem(mineflayer, item_name, num)
      return `Smelted [${item_name}] ${num} time(s)`
    },
  },
  {
    name: 'clearFurnace',
    description: 'Take all items out of the nearest furnace.',
    execution: 'async',
    schema: z.object({}),
    perform: mineflayer => async () => {
      await skills.clearNearestFurnace(mineflayer)
      return 'Cleared furnace'
    },
  },
  {
    name: 'placeHere',
    description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
    execution: 'async',
    schema: z.object({
      type: z.string().describe('The block type to place.'),
    }),
    perform: mineflayer => async (type: string) => {
      const pos = mineflayer.bot.entity.position
      return await placeBlock(mineflayer, type, pos.x, pos.y, pos.z)
    },
  },
  {
    name: 'attack',
    description: 'Attack and kill the nearest entity of a given type.',
    execution: 'async',
    schema: z.object({
      type: z.string().describe('The type of entity to attack.'),
    }),
    perform: mineflayer => async (type: string) => {
      await skills.attackNearest(mineflayer, type, true)
      return `Attacked nearest [${type}]`
    },
  },
  {
    name: 'attackPlayer',
    description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
    execution: 'async',
    schema: z.object({
      player_name: z.string().describe('The name of the player to attack.'),
    }),
    perform: mineflayer => async (player_name: string) => {
      const player = mineflayer.bot.players[player_name]?.entity
      if (!player) {
        throw new ActionError('TARGET_NOT_FOUND', `Could not find player ${player_name}`, { playerName: player_name })
      }
      await skills.attackEntity(mineflayer, player, true)
      return `Attacked player [${player_name}]`
    },
  },
  {
    name: 'goToBed',
    description: 'Go to the nearest bed and sleep.',
    execution: 'async',
    schema: z.object({}),
    perform: mineflayer => async () => {
      await skills.goToBed(mineflayer)
      return 'Slept in a bed'
    },
  },
  {
    name: 'activate',
    description: 'Activate the nearest object of a given type.',
    execution: 'async',
    schema: z.object({
      type: z.string().describe('The type of object to activate.'),
    }),
    perform: mineflayer => async (type: string) => {
      return await activateNearestBlock(mineflayer, type)
    },
  },
  {
    name: 'recipePlan',
    description: 'Plan how to craft an item. Shows the full recipe tree, what resources you have, what you\'re missing, and whether you can craft it now. Use this BEFORE attempting to craft complex items to understand what you need.',
    execution: 'sync',
    schema: z.object({
      item_name: z.string().describe('The name of the item you want to craft (e.g., "diamond_pickaxe", "oak_planks").'),
      amount: z.number().int().min(1).default(1).describe('How many of the item you want to craft.'),
    }),
    perform: mineflayer => (item_name: string, amount: number = 1): string => {
      return pad(describeRecipePlan(mineflayer.bot, item_name, amount))
    },
  },

  // ---------------------------------------------------------------------------------------------
  // Navigation to a searched-for target.
  //
  // NOTICE: these two are the highest-value additions in this batch. Without them the model wrote
  // `query.entities().whereName("pig").first().pos.x` by hand, which throws an opaque
  // "Cannot read properties of undefined" whenever nothing matches — the failure that
  // `augmentDecisionError` in `cognitive/conscious/brain.ts` was written to rescue, after it was
  // observed repeating the same crash for several turns before giving up.
  // ---------------------------------------------------------------------------------------------
  {
    name: 'goToNearestEntity',
    description: 'Walk to the nearest entity of a given type (e.g. pig, cow, zombie, villager). Prefer this over looking up coordinates yourself — it reports clearly when nothing of that type is nearby instead of crashing.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      entity_type: z.string().describe('The entity type to approach, e.g. "pig", "cow", "villager".'),
      closeness: z.number().min(0).default(2).describe('How close to get, in blocks.'),
      range: z.number().min(1).max(512).default(64).describe('How far to search, in blocks.'),
    }),
    perform: mineflayer => async (entity_type: string, closeness = 2, range = 64) => {
      return await skills.goToNearestEntity(mineflayer, entity_type, closeness, range)
    },
  },
  {
    name: 'goToNearestBlock',
    description: 'Walk to the nearest block of a given type (e.g. crafting_table, furnace, oak_log, water). Reports the block coordinates on success, and says plainly when none is in range.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      block_type: z.string().describe('The block type to approach, e.g. "crafting_table", "iron_ore".'),
      closeness: z.number().min(0).default(2).describe('How close to get, in blocks.'),
      range: z.number().min(1).max(512).default(64).describe('How far to search, in blocks.'),
    }),
    perform: mineflayer => async (block_type: string, closeness = 2, range = 64) => {
      return await skills.goToNearestBlock(mineflayer, block_type, closeness, range)
    },
  },

  // ---------------------------------------------------------------------------------------------
  // The `ensure*` family: "make sure I have this, doing whatever it takes".
  //
  // Each one recursively gathers and crafts its own prerequisites, so a single call replaces a
  // multi-turn plan the model would otherwise have to sequence itself (and re-plan on every
  // failure). They are idempotent: calling them when the item is already in the inventory is a
  // cheap no-op.
  // ---------------------------------------------------------------------------------------------
  {
    name: 'ensurePickaxe',
    description: 'Make sure you have a pickaxe, crafting one from the best material you can afford (diamond down to wood), gathering wood/stone first if needed. No-op if you already have one. Call this before mining stone or ore.',
    execution: 'async',
    schema: quantitySchema,
    perform: mineflayer => async (quantity = 1) =>
      structured(`Have ${quantity} pickaxe(s).`, () => ensurePickaxe(mineflayer, quantity)),
  },
  {
    name: 'ensureSword',
    description: 'Make sure you have a sword, crafting one from the best material you can afford. No-op if you already have one. Call this before fighting.',
    execution: 'async',
    schema: quantitySchema,
    perform: mineflayer => async (quantity = 1) =>
      structured(`Have ${quantity} sword(s).`, () => ensureSword(mineflayer, quantity)),
  },
  {
    name: 'ensureAxe',
    description: 'Make sure you have an axe, crafting one if needed. Speeds up chopping wood considerably.',
    execution: 'async',
    schema: quantitySchema,
    perform: mineflayer => async (quantity = 1) =>
      structured(`Have ${quantity} axe(s).`, () => ensureAxe(mineflayer, quantity)),
  },
  {
    name: 'ensureShovel',
    description: 'Make sure you have a shovel, crafting one if needed. Speeds up digging dirt, sand and gravel.',
    execution: 'async',
    schema: quantitySchema,
    perform: mineflayer => async (quantity = 1) =>
      structured(`Have ${quantity} shovel(s).`, () => ensureShovel(mineflayer, quantity)),
  },
  {
    name: 'ensureHoe',
    description: 'Make sure you have a hoe, crafting one if needed. Required before tilling farmland.',
    execution: 'async',
    schema: quantitySchema,
    perform: mineflayer => async (quantity = 1) =>
      structured(`Have ${quantity} hoe(s).`, () => ensureHoe(mineflayer, quantity)),
  },
  {
    name: 'ensureCraftingTable',
    description: 'Make sure you have a crafting table in your inventory, crafting one from planks (and gathering wood first) if needed.',
    execution: 'async',
    schema: z.object({}),
    perform: mineflayer => async () =>
      structured('Have a crafting table.', () => ensureCraftingTable(mineflayer)),
  },
  {
    name: 'ensureFurnaces',
    description: 'Make sure you have furnaces, mining cobblestone and crafting them if needed.',
    execution: 'async',
    schema: quantitySchema,
    perform: mineflayer => async (quantity = 1) =>
      structured(`Have ${quantity} furnace(s).`, () => ensureFurnaces(mineflayer, quantity)),
  },
  {
    name: 'ensureChests',
    description: 'Make sure you have chests, crafting them from planks (gathering wood first) if needed.',
    execution: 'async',
    schema: quantitySchema,
    perform: mineflayer => async (quantity = 1) =>
      structured(`Have ${quantity} chest(s).`, () => ensureChests(mineflayer, quantity)),
  },
  {
    name: 'ensureTorches',
    description: 'Make sure you have torches, gathering sticks and coal and crafting them if needed. Useful before going underground or at night.',
    execution: 'async',
    schema: quantitySchema,
    perform: mineflayer => async (quantity = 1) =>
      structured(`Have ${quantity} torch(es).`, () => ensureTorches(mineflayer, quantity)),
  },
  {
    name: 'ensureCampfire',
    description: 'Make sure you have a campfire, gathering the planks, sticks and coal needed to craft one.',
    execution: 'async',
    schema: z.object({}),
    perform: mineflayer => async () =>
      structured('Have a campfire.', () => ensureCampfire(mineflayer)),
  },
  {
    name: 'ensurePlanks',
    description: 'Make sure you have at least this many planks, chopping trees and crafting logs into planks as needed.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      amount: z.number().int().min(1).max(256).describe('Total planks you need in inventory.'),
    }),
    perform: mineflayer => async (amount: number) =>
      structured(`Have ${amount} planks.`, () => ensurePlanks(mineflayer, amount)),
  },
  {
    name: 'ensureSticks',
    description: 'Make sure you have at least this many sticks, crafting planks into sticks (and gathering wood) as needed.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      amount: z.number().int().min(1).max(256).describe('Total sticks you need in inventory.'),
    }),
    perform: mineflayer => async (amount: number) =>
      structured(`Have ${amount} sticks.`, () => ensureSticks(mineflayer, amount)),
  },
  {
    name: 'ensureCobblestone',
    description: 'Make sure you have at least this much cobblestone, mining nearby stone as needed. Crafts a pickaxe first if you lack one.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      amount: z.number().int().min(1).max(256).describe('Total cobblestone you need in inventory.'),
    }),
    perform: mineflayer => async (amount: number) =>
      structured(`Have ${amount} cobblestone.`, () => ensureCobblestone(mineflayer, amount)),
  },
  {
    name: 'ensureCoal',
    description: 'Make sure you have at least this much coal, mining nearby coal ore as needed.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      amount: z.number().int().min(1).max(256).describe('Total coal you need in inventory.'),
    }),
    perform: mineflayer => async (amount: number) =>
      structured(`Have ${amount} coal.`, () => ensureCoal(mineflayer, amount)),
  },

  // ---------------------------------------------------------------------------------------------
  // World interaction beyond "place a single block at my feet".
  // ---------------------------------------------------------------------------------------------
  {
    name: 'gatherWood',
    description: 'Find trees and chop them until you have the requested number of logs. Handles walking between trees and picking up the drops. Prefer this over collectBlocks for wood.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      num: z.number().int().min(1).max(128).describe('How many logs to collect.'),
      max_distance: z.number().min(1).max(256).default(64).describe('How far to roam looking for trees.'),
    }),
    perform: mineflayer => async (num: number, max_distance = 64) =>
      structured(`Gathered wood until reaching ${num} logs.`, () => gatherWood(mineflayer, num, max_distance)),
  },
  {
    name: 'placeBlockAt',
    description: 'Place a block at specific coordinates, unlike placeHere which only places at your feet. Handles orientation for torches, stairs, ladders, buttons and levers. Use this to build.',
    execution: 'async',
    schema: z.object({
      type: z.string().describe('The block type to place, e.g. "oak_planks", "torch".'),
      x: z.number().describe('The x coordinate.'),
      y: z.number().min(-64).max(320).describe('The y coordinate.'),
      z: z.number().describe('The z coordinate.'),
      place_on: z.enum(['top', 'bottom', 'north', 'south', 'east', 'west', 'side'])
        .default('bottom')
        .describe('Which face of the neighbouring block to build off. Use "side" for wall torches.'),
    }),
    perform: mineflayer => async (type: string, x: number, y: number, z: number, place_on: any = 'bottom') => {
      return await placeBlock(mineflayer, type, x, y, z, place_on)
    },
  },
  {
    name: 'tillAndSow',
    description: 'Till a grass/dirt block into farmland and optionally plant a seed on it. Requires a hoe — call ensureHoe first.',
    execution: 'async',
    schema: z.object({
      x: z.number().describe('The x coordinate of the ground block to till.'),
      y: z.number().min(-64).max(320).describe('The y coordinate of the ground block to till.'),
      z: z.number().describe('The z coordinate of the ground block to till.'),
      seed_type: z.string().optional().describe('Seed to plant, e.g. "wheat_seeds", "carrot". Omit to only till.'),
    }),
    perform: mineflayer => async (x: number, y: number, z: number, seed_type?: string) => {
      return await tillAndSow(mineflayer, x, y, z, seed_type ?? null)
    },
  },
  {
    name: 'useDoor',
    description: 'Walk to the nearest door, open it, step through and close it behind you. Doors confuse the pathfinder, so use this rather than trying to walk through one with goToCoordinate.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({}),
    perform: mineflayer => async () => {
      return await useDoor(mineflayer)
    },
  },
  {
    name: 'pickupNearbyItems',
    description: 'Walk around collecting dropped item stacks off the ground nearby. Useful after a fight or after mining, or if drops were missed.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      distance: z.number().min(1).max(32).default(8).describe('How far to look for dropped items, in blocks.'),
    }),
    perform: mineflayer => async (distance = 8) => {
      return await pickupNearbyItems(mineflayer, distance)
    },
  },
  {
    name: 'moveAway',
    description: 'Walk roughly this far away in a random safe direction. Use when a spot is exhausted of resources, or to break out of a stuck situation.',
    execution: 'async',
    followControl: 'detach',
    schema: z.object({
      distance: z.number().min(1).max(128).default(16).describe('Roughly how far to move, in blocks.'),
    }),
    perform: mineflayer => async (distance = 16) => {
      return await skills.moveAway(mineflayer, distance)
    },
  },
  {
    name: 'stay',
    description: 'Stand still and do nothing for a while. Use when asked to wait somewhere. Capped at 300 seconds; interrupted early if something needs attention.',
    execution: 'async',
    schema: z.object({
      seconds: z.number().min(1).max(300).default(30).describe('How long to wait, in seconds.'),
    }),
    perform: mineflayer => async (seconds = 30) => {
      return await skills.stay(mineflayer, seconds)
    },
  },
  {
    name: 'organizeInventory',
    description: 'Tidy the inventory by merging partial stacks of the same item. Use when running low on free slots.',
    execution: 'async',
    schema: z.object({}),
    perform: mineflayer => async () =>
      structured('Organized the inventory.', () => organizeInventory(mineflayer)),
  },
]
