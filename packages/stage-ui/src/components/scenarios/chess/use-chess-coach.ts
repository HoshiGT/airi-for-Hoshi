import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { StreamEvent } from '../../../stores/llm'
import type { Side, Variant } from './shared'

import { errorMessageFrom } from '@moeru/std'
import { ref } from 'vue'

import { useLLM } from '../../../stores/llm'
import { useConsciousnessStore } from '../../../stores/modules/consciousness'
import { useProvidersStore } from '../../../stores/providers'
import { DEFAULT_COACH_PROMPT, opponentOf, sideLabel } from './shared'

/** One turn in the coach conversation. */
export interface CoachMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Live game state the coach reasons about. Getters (not refs) so the caller can
 * forward `game.*` without ref-variance friction; each is read fresh per ask so
 * the coach always sees the current position.
 */
export interface CoachGameView {
  variant: () => Variant
  /** Human-readable board (ASCII grid + piece list); FEN is unreadable to weak models. */
  board: () => string
  turn: () => Side
  history: () => string[]
  airiSide: () => Side
  playerLevel: () => string
  /**
   * Optional engine analysis of the current position (eval + top moves), run on
   * demand each ask. Lets the weak local model advise from the strong engine's
   * read; resolves undefined when no engine is available.
   */
  engineHint?: () => Promise<string | undefined>
}

function isTextDelta(event: StreamEvent): event is Extract<StreamEvent, { type: 'text-delta' }> {
  return event.type === 'text-delta'
}

/**
 * Builds the coach system prompt: the (possibly user-customized) persona first,
 * then an auto-generated block describing the live position (and the engine hint
 * when available). Rebuilt every ask so the model always sees the current FEN /
 * move history / side to move.
 */
function buildSystemPrompt(game: CoachGameView, persona: string, engineHint?: string): string {
  const variant = game.variant()
  const variantName = variant === 'xiangqi' ? '中国象棋' : '国际象棋'
  const moves = game.history().length ? game.history().join(' ') : '(还没走子)'

  // Name both sides so the model never confuses who is Airi and who is Hoshi.
  const airiSide = game.airiSide()
  const hoshiSide = opponentOf(airiSide)
  const turnSide = game.turn()
  const turnWho = turnSide === airiSide ? '你 Airi' : 'Hoshi'

  const lines = [
    persona.trim() || DEFAULT_COACH_PROMPT,
    '',
    `当前对局：${variantName}。你(Airi)执${sideLabel(variant, airiSide)}方，Hoshi 执${sideLabel(variant, hoshiSide)}方，Hoshi 自评水平：${game.playerLevel()}。`,
    game.board(),
    `走子记录(SAN)：${moves}`,
    `轮到${sideLabel(variant, turnSide)}方(${turnWho})走。`,
  ]
  if (engineHint) {
    // Inform the coach's advice, but it should speak naturally, not recite this.
    lines.push(`引擎分析（供你参考，用自己的话讲给 Hoshi，别照搬）：${engineHint}`)
  }
  return lines.join('\n')
}

/**
 * Reactive chess coach chat. Hoshi asks, Airi answers from the live position
 * using the main consciousness model (e.g. local qwythos). Reactive only — the
 * coach never speaks unless asked. The engine still chooses Airi's moves; the
 * coach explains and advises.
 *
 * @param game    Getters for the live position.
 * @param persona Getter for the user-editable coach persona; read fresh per ask
 *                so edits in settings take effect without restarting the game.
 */
export function useChessCoach(game: CoachGameView, persona: () => string = () => DEFAULT_COACH_PROMPT) {
  const consciousnessStore = useConsciousnessStore()
  const providersStore = useProvidersStore()
  const llm = useLLM()

  const messages = ref<CoachMessage[]>([])
  const sending = ref(false)

  /**
   * Ask the coach and stream its reply into `messages`. Resolves to the final
   * assistant text so a voice caller can speak it (see {@link useChessVoice});
   * the typed UI path ignores the return value, keeping typed Q&A silent.
   * Returns `''` when there is nothing to answer (empty input, busy, no model).
   */
  async function ask(text: string): Promise<string> {
    const question = text.trim()
    if (!question || sending.value) {
      return ''
    }

    const providerId = consciousnessStore.activeProvider
    // A manually typed custom model name takes precedence over a picked one.
    const model = consciousnessStore.customModelName.trim() || consciousnessStore.activeModel.trim()
    if (!providerId || !model) {
      messages.value.push(
        { role: 'user', content: question },
        { role: 'assistant', content: '我还没接上大脑呢～先去 设置 → 模型 选一个主模型（比如本地 qwythos），我就能陪你聊啦。' },
      )
      return ''
    }

    // Snapshot prior turns before appending the new pair, so the request carries
    // the conversation history but not the empty assistant placeholder.
    const priorTurns: Message[] = messages.value.map(message => ({ role: message.role, content: message.content }))

    messages.value.push({ role: 'user', content: question }, { role: 'assistant', content: '' })
    const assistant = messages.value[messages.value.length - 1]
    sending.value = true

    // Runs the engine (brief main-thread work); the placeholder shows 思考中… meanwhile.
    const engineHint = game.engineHint ? await game.engineHint() : undefined

    const request: Message[] = [
      { role: 'system', content: buildSystemPrompt(game, persona(), engineHint) },
      ...priorTurns,
      { role: 'user', content: question },
    ]

    try {
      const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
      await llm.stream(model, chatProvider, request, {
        onStreamEvent: (event: StreamEvent) => {
          // Deep-reactive ref array: mutating the placeholder streams tokens in.
          if (isTextDelta(event)) {
            assistant.content += event.text
          }
        },
      })
    }
    catch (error) {
      assistant.content = `（出错了：${errorMessageFrom(error) ?? '未知错误'}）`
    }
    finally {
      sending.value = false
    }

    return assistant.content
  }

  function clear(): void {
    messages.value = []
  }

  return { messages, sending, ask, clear }
}
