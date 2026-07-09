import type { Variant } from '../shared/types'
import type { RulesAdapter } from './types'

import { createChessRules } from './chess'
import { createXiangqiRules } from './xiangqi'

export type { RulesAdapter } from './types'

/**
 * Creates the rules adapter for a variant. Async so the xiangqi (ffish/WASM)
 * adapter and the synchronous chess adapter share one call site.
 */
export async function createRules(variant: Variant, fen?: string): Promise<RulesAdapter> {
  if (variant === 'xiangqi') {
    return await createXiangqiRules(fen)
  }
  return createChessRules(fen)
}
