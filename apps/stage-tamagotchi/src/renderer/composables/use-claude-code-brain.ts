import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { storeToRefs } from 'pinia'
import { watch } from 'vue'

import { electronBrainStart, electronBrainStop } from '../../shared/eventa'

// NOTICE:
// Mirrors DEFAULT_PORT in
// packages/stage-ui/src/libs/providers/providers/claude-code/index.ts.
// The stored provider config can be missing (provider never configured) or
// port-less, so the fallback cannot come from the config itself.
const DEFAULT_BRAIN_PORT = 14515

/**
 * Starts/stops the Claude Code brain sidecar (owned by Electron main) when the
 * active chat provider changes. Provider switches made from any window are
 * visible here because the consciousness store persists via localStorage and
 * syncs across windows, while the manager's lifecycle mutex serializes the
 * resulting concurrent start/stop invokes.
 */
export function useClaudeCodeBrain() {
  const consciousnessStore = useConsciousnessStore()
  const providersStore = useProvidersStore()
  const { activeProvider } = storeToRefs(consciousnessStore)

  const startBrain = useElectronEventaInvoke(electronBrainStart)
  const stopBrain = useElectronEventaInvoke(electronBrainStop)

  function resolveBrainPort() {
    const config = providersStore.getProviderConfig('claude-code') as { port?: number } | undefined
    const port = Number(config?.port)
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_BRAIN_PORT
  }

  watch(activeProvider, (provider, previous) => {
    if (provider === previous)
      return

    if (provider === 'claude-code') {
      void startBrain({ port: resolveBrainPort() }).catch((error) => {
        console.warn('[brain] Failed to start the Claude Code brain:', error)
      })
    }
    else if (previous === 'claude-code') {
      void stopBrain().catch((error) => {
        console.warn('[brain] Failed to stop the Claude Code brain:', error)
      })
    }
  }, { immediate: true })
}
