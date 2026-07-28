import type { Action } from '../../libs/mineflayer'
import type { Mineflayer } from '../../libs/mineflayer/core'

import { config } from '../../composables/config'
import { actionsList } from './llm-actions'

/** Tools that need the headless renderer; removed wholesale when vision is disabled. */
const VISION_ACTIONS = new Set(['look'])

/**
 * ActionRegistry provides a centralized registry for all available actions
 * and replaces the deprecated actionAgent pattern
 */
export class ActionRegistry {
  private actions: Action[]
  private mineflayer: Mineflayer | null = null

  constructor() {
    // Vision tools are dropped rather than left to fail at call time: an advertised tool costs
    // description tokens on every single turn, and a blind bot should not be told it can see.
    this.actions = config.vision.enabled
      ? actionsList
      : actionsList.filter(action => !VISION_ACTIONS.has(action.name))
  }

  /**
   * Set the mineflayer instance for action execution
   */
  public setMineflayer(mineflayer: Mineflayer): void {
    this.mineflayer = mineflayer
  }

  /**
   * Get all available actions
   */
  public getAvailableActions(): Action[] {
    return [...this.actions]
  }

  /**
   * Perform an action by name
   */
  public async performAction(step: { description?: string, tool: string, params: any }): Promise<unknown> {
    if (!this.mineflayer) {
      throw new Error('Mineflayer instance not set in ActionRegistry')
    }

    const action = this.actions.find(a => a.name === step.tool)
    if (!action) {
      throw new Error(`Unknown action: ${step.tool}`)
    }

    const actionFn = action.perform(this.mineflayer)
    const { schema } = action
    const parsedParams = schema.parse(step.params || {})

    // Extract parameter values in the order defined by the schema
    const paramValues = Object.keys((schema as any).shape || {}).map(key => parsedParams[key])

    const result = await actionFn(...paramValues)
    return result ?? `Action ${step.tool} completed`
  }

  /**
   * Register a new action
   */
  public registerAction(action: Action): void {
    this.actions.push(action)
  }

  /**
   * Get action by name
   */
  public getAction(name: string): Action | undefined {
    return this.actions.find(a => a.name === name)
  }
}
