import type { PlayerLevel, Variant } from '../../components/scenarios/chess'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { DEFAULT_COACH_PROMPT } from '../../components/scenarios/chess/shared'

/**
 * Settings for the in-app chess / xiangqi board module.
 *
 * Everything runs locally (ffish rules + a built-in search), so there is nothing
 * to connect; the store only persists the player's preferred defaults.
 */
export const useChessStore = defineStore('gaming-chess', () => {
  const enabled = useLocalStorageManualReset<boolean>('settings/gaming-chess/enabled', true)
  const defaultVariant = useLocalStorageManualReset<Variant>('settings/gaming-chess/variant', 'chess')
  const defaultLevel = useLocalStorageManualReset<PlayerLevel>('settings/gaming-chess/level', 'amateur')
  // Editable coach persona/instructions; the live position is appended at ask time.
  const coachPrompt = useLocalStorageManualReset<string>('settings/gaming-chess/coach-prompt', DEFAULT_COACH_PROMPT)

  // The board needs no external setup, so it is "configured" whenever enabled.
  const configured = computed(() => enabled.value)

  function resetState() {
    enabled.reset()
    defaultVariant.reset()
    defaultLevel.reset()
    coachPrompt.reset()
  }

  // The ref's `.reset()` is lost through `storeToRefs`, so the UI calls this
  // action to restore the coach persona to the built-in default.
  function resetCoachPrompt() {
    coachPrompt.reset()
  }

  return {
    enabled,
    defaultVariant,
    defaultLevel,
    coachPrompt,
    configured,
    resetState,
    resetCoachPrompt,
  }
})
