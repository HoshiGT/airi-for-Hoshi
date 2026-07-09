import type { ModelInfo } from '../providers'

import { listModels } from '@xsai/model'

/**
 * Model-id keywords used to pick out audio models from a mixed `/v1/models`
 * listing. Matching is case-insensitive substring on the model id.
 *
 * Keep entries to well-known model family names; anything missed is still
 * reachable through the show-all fallback in {@link listAudioModels}.
 */
const AUDIO_MODEL_KEYWORDS = {
  speech: ['tts', 'speech', 'kokoro', 'piper', 'bark'],
  transcription: ['whisper', 'transcribe', 'transcription', 'asr', 'stt', 'sensevoice', 'paraformer'],
} satisfies Record<string, string[]>

export type AudioModelKind = keyof typeof AUDIO_MODEL_KEYWORDS

/**
 * Discovers speech (TTS) or transcription (ASR) models from an
 * OpenAI-compatible server's `/v1/models` endpoint.
 *
 * Discovery is best-effort and never throws: single-purpose local servers
 * (whisper.cpp, kokoro-fastapi, speaches, ...) may not implement `/v1/models`
 * at all, and manual model entry in the settings UI is the supported fallback
 * for exactly that case — a hard error here would replace the manual input
 * with a blocking error state.
 *
 * `apiKey` is optional: local LAN speech servers typically run without
 * authentication, while servers that do require a key simply reject the
 * request and fall into the empty-result path.
 */
export async function listAudioModels(
  config: Record<string, unknown>,
  kind: AudioModelKind,
  providerId: string,
): Promise<ModelInfo[]> {
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  let baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : ''

  if (!baseUrl)
    return []
  if (!baseUrl.endsWith('/'))
    baseUrl += '/'

  let models
  try {
    models = await listModels({
      apiKey: apiKey || undefined,
      baseURL: baseUrl,
    })
  }
  catch (error) {
    console.warn(`[${providerId}] Model discovery via /v1/models failed, falling back to manual model entry:`, error)
    return []
  }

  const keywords = AUDIO_MODEL_KEYWORDS[kind]
  const matched = models.filter(model => keywords.some(keyword => model.id.toLowerCase().includes(keyword)))

  // Dedicated audio servers often name models without any recognizable
  // keyword (e.g. speaches serves "Systran/faster-whisper-small" next to
  // "speaches-ai/Kokoro-82M-v1.0-ONNX"). When the keyword filter would hide
  // everything, show the full listing instead and let the user pick — an
  // empty list would suggest the server has no models at all.
  const visible = matched.length > 0 ? matched : models

  return visible.map((model: any) => {
    return {
      id: model.id,
      name: model.name || model.display_name || model.id,
      provider: providerId,
      description: model.description || '',
      contextLength: model.context_length || 0,
      deprecated: false,
    } satisfies ModelInfo
  })
}
