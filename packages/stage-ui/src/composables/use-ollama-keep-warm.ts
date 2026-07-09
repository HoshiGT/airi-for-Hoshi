/**
 * Keeps a local Ollama chat model resident while Airi is open.
 *
 * Ollama lazily loads a model into memory on first use and unloads it after an
 * idle keep-alive timeout (~5 min by default). A sporadic message — e.g. an
 * incoming QQ DM arriving after a quiet spell — would otherwise pay the full
 * model-load latency again. While this composable's owner is mounted AND the
 * main brain (consciousness) runs on Ollama, it re-issues a no-token load
 * request on a heartbeat shorter than that timeout, so the model never idles
 * out and replies stay instant.
 *
 * Lifecycle:
 * - Warms immediately when Ollama becomes the active provider (covers both app
 *   boot and switching the brain to Ollama at runtime).
 * - Re-warms on the heartbeat while Ollama stays active.
 * - Pauses when the provider changes away from Ollama, and stops on owner
 *   unmount — the model then unloads on Ollama's own idle timer, freeing memory
 *   when Airi is no longer in use.
 *
 * Visibility is intentionally ignored: QQ replies happen while the tab is in
 * the background, which is exactly when the model must stay warm.
 *
 * Call once from the app root (e.g. App.vue `<script setup>`).
 */

import { useIntervalFn } from '@vueuse/core'
import { watch } from 'vue'

import { warmUpOllamaModel } from '../libs/providers/providers/ollama'
import { useConsciousnessStore } from '../stores/modules/consciousness'
import { useProvidersStore } from '../stores/providers'

/** Default Ollama base URL, mirrors the provider config schema default. */
const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1/'

/**
 * Heartbeat interval. Must stay below Ollama's default 5-minute idle keep-alive
 * so each ping resets the unload timer before it fires; 4 minutes leaves a
 * 1-minute safety margin.
 */
const KEEP_WARM_INTERVAL_MS = 4 * 60 * 1000

export function useOllamaKeepWarm() {
  const consciousnessStore = useConsciousnessStore()
  const providersStore = useProvidersStore()

  /** The Ollama model the brain currently uses, or undefined when it is not on Ollama. */
  function resolveOllamaModel(): string | undefined {
    if (consciousnessStore.activeProvider !== 'ollama')
      return undefined

    // A manually typed custom model name takes precedence over a picked one.
    const model = consciousnessStore.customModelName.trim() || consciousnessStore.activeModel.trim()
    return model || undefined
  }

  async function warmActiveModel(): Promise<void> {
    const model = resolveOllamaModel()
    if (!model)
      return

    const config = providersStore.getProviderConfig('ollama')
    const configuredBaseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.trim() : ''
    const baseUrl = configuredBaseUrl || OLLAMA_DEFAULT_BASE_URL

    try {
      await warmUpOllamaModel(baseUrl, model)
    }
    catch (error) {
      // Non-fatal: the model still loads on the next real request.
      console.warn('[OllamaKeepWarm] warm-up failed:', error)
    }
  }

  // `immediate: false` so the timer only runs while Ollama is the active brain;
  // `useIntervalFn` auto-stops on scope dispose (owner unmount).
  const heartbeat = useIntervalFn(warmActiveModel, KEEP_WARM_INTERVAL_MS, { immediate: false })

  // Drive the heartbeat off the resolved Ollama model. `immediate` warms right
  // away when Ollama is (or becomes) active; re-firing on model change rewarms
  // the newly selected model without waiting a full interval.
  watch(
    resolveOllamaModel,
    (model) => {
      if (model) {
        void warmActiveModel()
        if (!heartbeat.isActive.value)
          heartbeat.resume()
      }
      else if (heartbeat.isActive.value) {
        heartbeat.pause()
      }
    },
    { immediate: true },
  )

  return heartbeat
}
