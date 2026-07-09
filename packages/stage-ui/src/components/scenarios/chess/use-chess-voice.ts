import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'
import type { Ref } from 'vue'

import type { AudioManagerType } from '../../../libs/audio/manager'

import { errorMessageFrom } from '@moeru/std'
import { until } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { onUnmounted, ref } from 'vue'

// NOTICE:
// Imported with `?worker&url` the same way stage-ui's own hearing store does
// (`stores/modules/hearing.ts`). The VAD runs in a worklet; useVAD needs the
// built worklet URL, not the module.
import workletUrl from '../../../workers/vad/process.worklet?worker&url'

import { useAudioRecorder } from '../../../composables/audio/audio-recorder'
import { createAudioManager, playAudio } from '../../../libs/audio/manager'
import { useVAD } from '../../../stores/ai/models/vad'
import { useHearingSpeechInputPipeline, useHearingStore } from '../../../stores/modules/hearing'
import { useSpeechStore } from '../../../stores/modules/speech'
import { useProvidersStore } from '../../../stores/providers'
import { useSettingsAudioDevice } from '../../../stores/settings'

/**
 * Voice-mode lifecycle phase for the coach conversation.
 *
 * - `idle`      voice mode off; mic released.
 * - `listening` mic hot, VAD waiting for Hoshi to speak.
 * - `thinking`  an utterance was captured; transcribing + waiting for the reply.
 * - `speaking`  Airi's reply is playing back through TTS.
 *
 * The phase is also the turn-taking gate: a new recording only starts while
 * `listening`, so Airi never transcribes its own playback and turns never overlap.
 */
export type ChessVoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface UseChessVoiceOptions {
  /**
   * Handles a recognized utterance and returns the assistant reply to speak.
   * Wire this to the coach's `ask`; the returned text is synthesized aloud.
   * Return an empty string (or nothing) to stay silent.
   */
  onTranscript: (text: string) => Promise<string | undefined | void>
}

export interface ChessVoiceController {
  /** Whether hands-free voice mode is currently on. */
  enabled: Ref<boolean>
  /** Current turn-taking phase; drives the mic gate and the UI indicator. */
  phase: Ref<ChessVoicePhase>
  /** Last user-facing error/hint (e.g. STT/TTS not configured). */
  error: Ref<string | undefined>
  /** Turn voice mode on (acquires mic + loads VAD). Safe to call when already on. */
  enable: () => Promise<void>
  /** Turn voice mode off and release the mic. */
  disable: () => void
  /** Toggle voice mode. */
  toggle: () => Promise<void>
}

/**
 * Hands-free voice conversation for the chess coach: Hoshi speaks, Whisper
 * transcribes, the coach answers, and the answer is spoken back via TTS.
 *
 * Reuses the app's existing audio plumbing rather than re-implementing it:
 * the shared mic stream + VAD ({@link useVAD}) detect an utterance, the hearing
 * pipeline's recording-based transcription ({@link useHearingSpeechInputPipeline})
 * turns it into text (so it rides whatever STT provider is configured in
 * Settings → Modules → Hearing), and {@link useSpeechStore} + the audio manager
 * synthesize and play the reply with Airi's configured voice.
 *
 * Voice-in → voice-out only: typed questions answered through the same coach
 * stay silent (the text path does not call this composable).
 */
export function useChessVoice(options: UseChessVoiceOptions): ChessVoiceController {
  const hearingStore = useHearingStore()
  const hearingPipeline = useHearingSpeechInputPipeline()
  const speechStore = useSpeechStore()
  const providersStore = useProvidersStore()

  const audioDevice = useSettingsAudioDevice()
  const { stream } = storeToRefs(audioDevice)
  const { startStream, stopStream } = audioDevice

  const enabled = ref(false)
  const phase = ref<ChessVoicePhase>('idle')
  const error = ref<string>()

  // NOTICE: only stop the shared mic stream on disable if WE started it. The
  // audio-device store is global (the main stage uses it too); tearing down a
  // stream the user enabled elsewhere would be a surprising side effect.
  let weStartedStream = false

  // Lazily created on first playback so the AudioContext is constructed after a
  // user gesture (the toggle click), satisfying browser autoplay policies.
  let audioManager: AudioManagerType | undefined

  const { startRecord, stopRecord, onStopRecord } = useAudioRecorder(stream)

  const { init: initVAD, start: startVAD, dispose: disposeVAD, loaded: vadLoaded, inferenceError: vadError } = useVAD(workletUrl, {
    // Record only while listening: ignore VAD fired during thinking/speaking so
    // Airi's own playback (and overlapping turns) never trigger a recording.
    onSpeechStart: () => {
      if (enabled.value && phase.value === 'listening')
        void startRecord()
    },
    onSpeechEnd: () => {
      if (enabled.value && phase.value === 'listening')
        void stopRecord()
    },
  })

  async function speak(text: string): Promise<void> {
    const providerId = speechStore.activeSpeechProvider
    if (!providerId || providerId === 'speech-noop' || !speechStore.configured) {
      // Reply is already visible in the chat; just nudge how to enable voice-out.
      error.value = '想让 Airi 出声的话，去 设置 → 语音（说话）配一个 TTS（内置 Kokoro 选 WASM 模型 = 跑 CPU）。'
      return
    }

    const provider = await providersStore.getProviderInstance<SpeechProviderWithExtraOptions<string, any>>(providerId)
    if (!provider)
      throw new Error('Failed to initialize speech provider')

    const buffer = await speechStore.speech(
      provider,
      speechStore.activeSpeechModel,
      text,
      speechStore.activeSpeechVoiceId,
      providersStore.getProviderConfig(providerId) ?? {},
    )

    audioManager ??= createAudioManager()
    await playAudio(audioManager, buffer)
  }

  async function handleUtterance(recording: Blob): Promise<void> {
    // Block re-entry: while thinking/speaking the mic gate ignores new speech,
    // so this runs one turn at a time.
    phase.value = 'thinking'
    try {
      const text = (await hearingPipeline.transcribeForRecording(recording))?.trim()
      if (!text) {
        // Empty transcript (silence/noise) or a pipeline error surfaced on the store.
        error.value = hearingPipeline.error || error.value
        return
      }
      error.value = undefined

      const reply = (await options.onTranscript(text))?.trim()
      if (reply) {
        phase.value = 'speaking'
        await speak(reply)
      }
    }
    catch (err) {
      error.value = errorMessageFrom(err) ?? '语音处理失败'
    }
    finally {
      phase.value = enabled.value ? 'listening' : 'idle'
    }
  }

  onStopRecord(async (recording) => {
    // Stray callbacks (disabled mid-flight, or fired during thinking/speaking)
    // are dropped; only a clean utterance captured while listening is handled.
    if (!enabled.value || phase.value !== 'listening')
      return
    if (!recording || recording.size === 0)
      return
    await handleUtterance(recording)
  })

  async function enable(): Promise<void> {
    if (enabled.value)
      return
    error.value = undefined

    // Voice-in needs a transcription provider; without one, listening is pointless.
    if (!hearingStore.configured) {
      error.value = '先去 设置 → 模块 → 听觉（Hearing）选一个语音识别 provider（本地 Whisper 走 OpenAI 兼容），再开语音对话。'
      return
    }

    enabled.value = true
    try {
      if (!stream.value) {
        weStartedStream = true
        await startStream()
        await until(stream).toBeTruthy({ timeout: 5000, throwOnTimeout: true })
      }
      await initVAD()
      // initVAD swallows load failures into inferenceError instead of throwing,
      // and startVAD silently no-ops without a manager — so check explicitly,
      // otherwise the UI would show "listening" while nothing is actually heard.
      if (!vadLoaded.value)
        throw new Error(vadError.value || '语音活动检测(VAD)模型加载失败。')
      if (stream.value)
        await startVAD(stream.value)
      phase.value = 'listening'
    }
    catch (err) {
      error.value = errorMessageFrom(err) ?? '麦克风启动失败，检查麦克风权限。'
      disable()
    }
  }

  function disable(): void {
    enabled.value = false
    phase.value = 'idle'
    disposeVAD()
    if (weStartedStream) {
      stopStream()
      weStartedStream = false
    }
  }

  async function toggle(): Promise<void> {
    if (enabled.value)
      disable()
    else
      await enable()
  }

  onUnmounted(() => {
    disable()
    // Release the playback AudioContext created lazily in speak().
    void audioManager?.audioContext.close().catch(() => {})
    audioManager = undefined
  })

  return {
    enabled,
    phase,
    error,
    enable,
    disable,
    toggle,
  }
}
