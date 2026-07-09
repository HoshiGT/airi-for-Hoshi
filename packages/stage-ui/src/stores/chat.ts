import type { ChatOrchestratorRuntimeState, ChatOrchestratorSendOptions, StreamEvent, StreamOptions } from '@proj-airi/core-agent'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { ChatHistoryItem } from '../types/chat'

import { errorMessageFrom } from '@moeru/std'
import { createChatOrchestratorRuntime } from '@proj-airi/core-agent'
import { IOAttributes, IOEvents, IOSpanNames, IOSubsystems } from '@proj-airi/stage-shared'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref, toRaw, watch } from 'vue'

import { useAnalytics } from '../composables'
import { activeTurnSpan, startSpan } from '../composables/use-io-tracer'
import { extractMessageText, isCloudSyncableMessage } from '../libs/chat-sync'
import { createMinecraftContext } from './chat/context-providers'
import { useChatContextStore } from './chat/context-store'
import { useMemoryService } from './chat/memory'
import { planConsolidation } from './chat/memory/trim'
import { useChatSessionStore } from './chat/session-store'
import { useChatStreamStore } from './chat/stream-store'
import { useContextObservabilityStore } from './devtools/context-observability'
import { useLLM } from './llm'
import { useLlmToolsetPromptsStore } from './llm-toolset-prompts'
import { useAiriCardStore } from './modules/airi-card'
import { useAutonomousArtistryStore } from './modules/artistry-autonomous'
import { useConsciousnessStore } from './modules/consciousness'
import { useMemoryStore } from './modules/memory'

interface ForkOptions {
  fromSessionId?: string
  atIndex?: number
  reason?: string
  hidden?: boolean
}

type ProviderHistoryMessage = Exclude<ChatHistoryItem, { role: 'error' }>

/**
 * Strips UI-only `error` entries so the history is valid provider input.
 * Shared with the manual memory-consolidation flow in the maintenance store.
 */
export function toProviderHistory(messages: ChatHistoryItem[]): Message[] {
  return messages.filter((message): message is ProviderHistoryMessage => message.role !== 'error')
}

function isTextDelta(event: StreamEvent): event is Extract<StreamEvent, { type: 'text-delta' }> {
  return event.type === 'text-delta'
}

export type { QueuedSendSnapshot, ChatOrchestratorSendOptions as SendOptions } from '@proj-airi/core-agent'

export const useChatOrchestratorStore = defineStore('chat-orchestrator', () => {
  const llmStore = useLLM()
  const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
  const consciousnessStore = useConsciousnessStore()
  const artistryAutonomousStore = useAutonomousArtistryStore()
  const { activeModel, activeProvider } = storeToRefs(consciousnessStore)
  const {
    trackFirstMessage,
    trackChatFailed,
    trackChatStarted,
    trackMessageSendStarted,
    trackMessageSent,
    trackLlmRequestStarted,
    trackLlmFirstToken,
    trackAssistantResponseRendered,
    trackAssistantResponseCompleted,
    trackMessageRound,
    trackFeatureUsed,
    trackChatActivationStarted,
    trackChatActivationSucceeded,
    trackChatActivationFailed,
    trackSecondTurnStarted,
  } = useAnalytics()

  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const cardStore = useAiriCardStore()
  const contextObservability = useContextObservabilityStore()
  const memoryStore = useMemoryStore()
  const memoryService = useMemoryService()
  const { activeSessionId } = storeToRefs(chatSession)
  const { streamingMessage } = storeToRefs(chatStream)

  const sending = ref(false)
  const pendingQueuedSendCount = ref(0)
  let ownedActiveTurnSpan: typeof activeTurnSpan.value

  async function streamWithStageAdapters(
    model: string,
    chatProvider: ChatProvider,
    messages: Message[],
    options?: StreamOptions,
  ) {
    let llmTextLength = 0

    const hadExistingTurn = !!activeTurnSpan.value
    if (!hadExistingTurn) {
      const turnSpan = startSpan(IOSpanNames.InteractionTurn)
      activeTurnSpan.value = turnSpan
      ownedActiveTurnSpan = turnSpan
    }

    const llmSpan = startSpan(IOSpanNames.LLMInference, activeTurnSpan.value, {
      [IOAttributes.Subsystem]: IOSubsystems.LLM,
      [IOAttributes.GenAIRequestModel]: model,
    })
    const llmRequestTs = performance.now()
    let llmFirstTokenEmitted = false

    try {
      await llmStore.stream(model, chatProvider, messages, {
        ...options,
        onStreamEvent: async (event: StreamEvent) => {
          if (isTextDelta(event)) {
            if (!llmFirstTokenEmitted) {
              llmFirstTokenEmitted = true
              llmSpan.addEvent(IOEvents.LLMFirstToken, {
                [IOAttributes.LLM_TTFT]: performance.now() - llmRequestTs,
              })
            }
            llmTextLength += event.text.length
          }

          await options?.onStreamEvent?.(event)
        },
      })

      llmSpan.setAttribute(IOAttributes.LLMTextLength, llmTextLength)
    }
    finally {
      llmSpan.end()
    }
  }

  function syncRuntimeState(state: ChatOrchestratorRuntimeState) {
    sending.value = state.sending
    pendingQueuedSendCount.value = state.pendingQueuedSendCount
  }

  function settleOwnedActiveTurnSpan() {
    if (!ownedActiveTurnSpan)
      return

    ownedActiveTurnSpan.end()
    if (activeTurnSpan.value === ownedActiveTurnSpan)
      activeTurnSpan.value = undefined
    ownedActiveTurnSpan = undefined
  }

  // Sessions with an in-flight consolidation pass. Guards a second pass from
  // starting for the same session while the async model call + trim runs.
  // Keyed by sessionId so the UI session and each QQ DM (`qq-private-*`) each
  // consolidate independently — they share the orchestrator but not their
  // round cadence.
  const consolidatingSessions = new Set<string>()

  /**
   * After a completed turn, summarize+archive the oldest rounds of `sessionId`
   * and trim them from the live context once the round count crosses the
   * configured high-water mark.
   *
   * Fire-and-forget from the turn hook: it must never block the reply, and a
   * failed summary must never lose live history — trimming happens only after
   * `consolidate` resolves, and only the archived ids are removed.
   */
  async function maybeConsolidateSession(sessionId: string) {
    if (!memoryStore.configured)
      return
    if (consolidatingSessions.has(sessionId))
      return

    // Detach from the reactive proxy: the archived messages are persisted into
    // the memory DB and handed to the model, so they must be plain snapshots.
    const snapshot = chatSession.getSessionMessages(sessionId).map(message => toRaw(message))
    const plan = planConsolidation(snapshot, {
      triggerRounds: memoryStore.triggerRounds,
      retainRounds: memoryStore.retainRounds,
    })
    if (!plan)
      return

    consolidatingSessions.add(sessionId)
    try {
      await memoryService.consolidate(sessionId, toProviderHistory(plan.archived), {
        roundFrom: plan.roundFrom,
        roundTo: plan.roundTo,
        // Undo backup: the raw session items (ids included) about to be trimmed.
        archivedSessionMessages: plan.archived,
      })

      // Trim by id against the *current* list, not the snapshot: messages that
      // arrived while the model call ran keep their place; only the archived
      // rounds are removed.
      const current = chatSession.getSessionMessages(sessionId)
      const trimmed = current.filter(message => !message.id || !plan.archivedIds.has(message.id))
      chatSession.setSessionMessages(sessionId, trimmed)
    }
    catch (err) {
      // Leave live history intact on failure; the next completed turn retries.
      console.warn('[chat] memory consolidation failed for', sessionId, errorMessageFrom(err))
    }
    finally {
      consolidatingSessions.delete(sessionId)
    }
  }

  /**
   * Classifies configured chat providers into low-cardinality product analytics buckets.
   */
  function providerMode(providerId: string | undefined): 'official' | 'custom' | 'unknown' {
    if (!providerId)
      return 'unknown'
    return providerId.startsWith('official-provider') ? 'official' : 'custom'
  }

  let lastSendSource: 'text' | 'voice' = 'text'

  const runtime = createChatOrchestratorRuntime({
    session: {
      ensureSession: sessionId => chatSession.ensureSession(sessionId),
      getSessionMessages: sessionId => chatSession.getSessionMessages(sessionId).map(message => toRaw(message)),
      appendSessionMessage: (sessionId, message) => chatSession.appendSessionMessage(sessionId, message),
      getSessionGeneration: sessionId => chatSession.getSessionGeneration(sessionId),
    },
    context: {
      ingest: envelope => chatContext.ingestContextMessage(envelope),
      snapshot: () => chatContext.getContextsSnapshot(),
    },
    foregroundStream: {
      patch: (message) => {
        streamingMessage.value = message
      },
      reset: () => {
        streamingMessage.value = { role: 'assistant', content: '', slices: [], tool_results: [] }
      },
    },
    llm: {
      stream: streamWithStageAdapters,
    },
    getActiveSessionId: () => activeSessionId.value,
    getActiveProvider: () => activeProvider.value,
    getSystemPromptSupplement: () => llmToolsetPromptsStore.activeToolsetPrompt,
    runtimeContextProviders: [
      createMinecraftContext,
    ],
    createId: nanoid,
    unwrapMessage: message => toRaw(message),
    onStateChange: syncRuntimeState,
    onSendSettled: settleOwnedActiveTurnSpan,
    onTrackFirstMessage: trackFirstMessage,
    onMessageSendStarted: ({ source, model }) => {
      lastSendSource = source
      trackMessageSendStarted({
        source,
        model,
      })
      trackChatStarted({
        conversation_id: activeSessionId.value || 'unknown',
        provider_type: providerMode(activeProvider.value),
        provider_name: activeProvider.value || 'unknown',
        model: model || 'unknown',
        entry: 'chat',
      })
    },
    onLlmRequestStarted: ({ model, provider, hasVoice }) => trackLlmRequestStarted({
      model,
      provider,
      has_voice: hasVoice,
    }),
    onLlmFirstToken: ({ model, ttfbMs }) => trackLlmFirstToken({
      model,
      ttfb_ms: ttfbMs,
    }),
    onAssistantResponseRendered: ({ model, latencyMs }) => {
      trackAssistantResponseRendered({
        model,
        latency_ms: latencyMs,
      })
      trackAssistantResponseCompleted({
        conversation_id: activeSessionId.value || 'unknown',
        provider_type: providerMode(activeProvider.value),
        provider_name: activeProvider.value || 'unknown',
        model: model || 'unknown',
        latency_ms: latencyMs,
      })
    },
    onMessageRound: ({ durationMs, hasVoice, model }) => trackMessageRound({
      duration_ms: durationMs,
      has_voice: hasVoice,
      model,
    }),
    onChatActivationStarted: ({ model, provider, source }) => {
      const mode = providerMode(provider)
      const providerId = provider || 'unknown'
      const modelId = model || 'unknown'

      trackChatActivationStarted({
        provider_mode: mode,
        provider_id: providerId,
        model_id: modelId,
        source,
      })
    },
    onChatActivationSucceeded: ({ model, provider, durationMs, source }) => trackChatActivationSucceeded({
      provider_mode: providerMode(provider),
      provider_id: provider || 'unknown',
      model_id: model || 'unknown',
      time_to_first_message_ms: durationMs,
      source,
    }),
    onChatActivationFailed: ({ model, provider, errorCode, failureStage, source }) => {
      trackChatActivationFailed({
        provider_mode: providerMode(provider),
        provider_id: provider || 'unknown',
        model_id: model || 'unknown',
        error_code: errorCode,
        failure_stage: failureStage,
        source,
      })
      trackChatFailed({
        conversation_id: activeSessionId.value || 'unknown',
        provider_type: providerMode(provider),
        provider_name: provider || 'unknown',
        model: model || 'unknown',
        failure_stage: failureStage,
        error_code: errorCode,
      })
    },
    onLifecycle: record => contextObservability.recordLifecycle(record),
    onPromptProjection: payload => contextObservability.capturePromptProjection(payload),
    onUserMessageAppended: ({ sessionId, message, messageText, source, model, provider, turnIndex }) => {
      trackMessageSent({
        conversation_id: sessionId,
        provider_type: providerMode(activeProvider.value),
        provider_name: activeProvider.value || 'unknown',
        model: activeModel.value || 'unknown',
        message_id: message.id,
        message_index: chatSession.getSessionMessages(sessionId).length,
        message_length: messageText.length,
        has_attachment: false,
        mode: lastSendSource,
      })
      trackFeatureUsed({
        feature_name: 'chat',
        business_domain: 'conversation',
        entry: 'chat',
        success: true,
      })
      if (turnIndex === 2) {
        trackSecondTurnStarted({
          provider_mode: providerMode(provider),
          provider_id: provider || 'unknown',
          model_id: model || 'unknown',
          source,
          turn_index: turnIndex,
        })
      }

      if (isCloudSyncableMessage(message)) {
        void chatSession.pushMessageToCloud(sessionId, {
          id: message.id,
          role: 'user',
          content: messageText,
        })
      }
    },
    onAssistantMessageAppended: ({ sessionId, message }) => {
      if (isCloudSyncableMessage(message) && message.id) {
        void chatSession.pushMessageToCloud(sessionId, {
          id: message.id,
          role: 'assistant',
          content: extractMessageText(message),
        })
      }
      // Per-session memory consolidation (UI session + each QQ DM). Uses the
      // hook's sessionId, never activeSessionId, so QQ turns consolidate their
      // own session even when the UI is focused elsewhere.
      void maybeConsolidateSession(sessionId)
    },
    onUserTurnReady: ({ messageText, sessionMessages }) => {
      const autonomousTarget = cardStore.activeCard?.extensions?.airi?.modules?.artistry?.autonomousTarget || 'user'
      if (autonomousTarget === 'user')
        void artistryAutonomousStore.runArtistTask(messageText, toProviderHistory(sessionMessages))
    },
    onAssistantTurnReady: ({ messageText, sessionMessages }) => {
      const artistry = cardStore.activeCard?.extensions?.airi?.modules?.artistry
      if (artistry?.autonomousEnabled && artistry?.autonomousTarget === 'assistant')
        void artistryAutonomousStore.runArtistTask(messageText, toProviderHistory(sessionMessages))
    },
  })

  watch(sending, (next) => {
    if (runtime.getSending() !== next)
      runtime.setSending(next)
  })

  async function ingest(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    targetSessionId?: string,
  ) {
    return runtime.ingest(sendingMessage, options, targetSessionId)
  }

  async function ingestOnFork(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    forkOptions?: ForkOptions,
  ) {
    const baseSessionId = forkOptions?.fromSessionId ?? activeSessionId.value
    if (!forkOptions)
      return ingest(sendingMessage, options, baseSessionId)

    const forkSessionId = await chatSession.forkSession({
      fromSessionId: baseSessionId,
      atIndex: forkOptions.atIndex,
      reason: forkOptions.reason,
      hidden: forkOptions.hidden,
    })
    return ingest(sendingMessage, options, forkSessionId || baseSessionId)
  }

  function cancelPendingSends(sessionId?: string) {
    runtime.cancelPendingSends(sessionId)
  }

  function getPendingQueuedSendSnapshot() {
    return runtime.getPendingQueuedSendSnapshot()
  }

  return {
    sending,
    pendingQueuedSendCount,

    ingest,
    ingestOnFork,
    cancelPendingSends,
    getPendingQueuedSendSnapshot,

    clearHooks: runtime.hooks.clearHooks,

    emitBeforeMessageComposedHooks: runtime.hooks.emitBeforeMessageComposedHooks,
    emitAfterMessageComposedHooks: runtime.hooks.emitAfterMessageComposedHooks,
    emitBeforeSendHooks: runtime.hooks.emitBeforeSendHooks,
    emitAfterSendHooks: runtime.hooks.emitAfterSendHooks,
    emitTokenLiteralHooks: runtime.hooks.emitTokenLiteralHooks,
    emitTokenSpecialHooks: runtime.hooks.emitTokenSpecialHooks,
    emitStreamEndHooks: runtime.hooks.emitStreamEndHooks,
    emitAssistantResponseEndHooks: runtime.hooks.emitAssistantResponseEndHooks,
    emitAssistantMessageHooks: runtime.hooks.emitAssistantMessageHooks,
    emitChatTurnCompleteHooks: runtime.hooks.emitChatTurnCompleteHooks,

    onBeforeMessageComposed: runtime.hooks.onBeforeMessageComposed,
    onAfterMessageComposed: runtime.hooks.onAfterMessageComposed,
    onBeforeSend: runtime.hooks.onBeforeSend,
    onAfterSend: runtime.hooks.onAfterSend,
    onTokenLiteral: runtime.hooks.onTokenLiteral,
    onTokenSpecial: runtime.hooks.onTokenSpecial,
    onStreamEnd: runtime.hooks.onStreamEnd,
    onAssistantResponseEnd: runtime.hooks.onAssistantResponseEnd,
    onAssistantMessage: runtime.hooks.onAssistantMessage,
    onChatTurnComplete: runtime.hooks.onChatTurnComplete,
  }
})
