import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/llm-tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/llm-toolset-prompts'
import { useDesktopControlStore } from '@proj-airi/stage-ui/stores/modules/desktop-control'
import { defineStore, storeToRefs } from 'pinia'
import { watch } from 'vue'

import { desktopControlGetAvailability } from '../../shared/eventa'
import { desktopControlTools } from './tools/builtin/desktop-control'

const TOOLS_PROVIDER = 'desktop-control'

/**
 * System-prompt guidance registered alongside the desktop-control tools so the
 * model knows the look-then-act loop and the coordinate space it must use.
 */
const TOOLSET_PROMPT = [
  'You can see and control the user\'s desktop.',
  'To act on screen, first call `desktop_look` to capture the current screen, then issue `desktop_mouse` / `desktop_keyboard` actions.',
  'Mouse coordinates are always in the pixel space of the most recent `desktop_look` screenshot (top-left origin); never guess coordinates without looking first.',
  'Prefer the smallest number of actions, and re-look after an action if you need to confirm the result.',
].join('\n')

/**
 * Owns registration of the Neuro-style desktop-control tools into the shared LLM
 * tools store, gated on the desktop-control module flags and the host's input
 * availability.
 *
 * Lifecycle: {@link initialize} probes the OS backend once and starts a watcher
 * that (un)registers tools whenever the module toggles or availability changes.
 * The watcher is the single owner of registration state, so duplicate calls to
 * {@link initialize} are ignored.
 */
export const useDesktopControlToolsStore = defineStore('tamagotchi-desktop-control-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
  const desktopControlStore = useDesktopControlStore()
  const { enabled, mouseEnabled, keyboardEnabled, inputAvailable, canControlMouse, canControlKeyboard } = storeToRefs(desktopControlStore)
  const getAvailability = useElectronEventaInvoke(desktopControlGetAvailability)

  let initialized = false

  async function refreshAvailability() {
    try {
      const availability = await getAvailability()
      desktopControlStore.setAvailability(availability)
    }
    catch (error) {
      console.warn(`[desktop-control] Failed to probe input backend: ${errorMessageFrom(error) ?? 'Unknown error'}`)
      desktopControlStore.setAvailability(null)
    }
  }

  function syncTools() {
    if (!enabled.value) {
      dispose()
      return
    }

    llmToolsetPromptsStore.registerToolsetPrompts(TOOLS_PROVIDER, [
      { id: TOOLS_PROVIDER, title: 'Desktop control', content: TOOLSET_PROMPT },
    ])

    void llmToolsStore.registerTools(
      TOOLS_PROVIDER,
      desktopControlTools({
        mouse: canControlMouse.value,
        keyboard: canControlKeyboard.value,
      }),
    )
  }

  function dispose() {
    llmToolsStore.clearTools(TOOLS_PROVIDER)
    llmToolsetPromptsStore.clearToolsetPrompts(TOOLS_PROVIDER)
  }

  async function initialize() {
    if (initialized)
      return
    initialized = true

    await refreshAvailability()

    // React to both the user's toggles and a late backend probe; `mouseEnabled`
    // / `keyboardEnabled` matter because they change which input tools register.
    watch(
      [enabled, mouseEnabled, keyboardEnabled, inputAvailable],
      () => syncTools(),
      { immediate: true },
    )
  }

  return {
    dispose,
    initialize,
    refreshAvailability,
  }
})
