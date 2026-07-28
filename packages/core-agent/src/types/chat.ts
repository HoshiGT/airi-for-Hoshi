import type { ContextUpdate, MetadataEventSource, WebSocketEventInputs } from '@proj-airi/server-shared/types'
import type { AssistantMessage, CommonContentPart, CompletionToolCall, Message, SystemMessage, ToolMessage, UserMessage } from '@xsai/shared-chat'

export interface ChatSlicesText {
  type: 'text'
  text: string
}

export interface ChatSlicesToolCall {
  type: 'tool-call'
  toolCall: CompletionToolCall
}

export interface ChatSlicesToolCallResult {
  type: 'tool-call-result'
  id: string
  isError?: boolean
  result?: string | CommonContentPart[]
}

/**
 * A sticker the model chose to send inline via a `<|STICKER_名字|>` marker.
 *
 * Only the sticker's display name is persisted — the image bytes live in the
 * renderer's sticker library (stage-ui sticker store) and are resolved at
 * render/delivery time, so chat history stays small and stickers can be
 * re-labeled or deleted without rewriting old messages.
 */
export interface ChatSlicesSticker {
  type: 'sticker'
  name: string
}

export type ChatSlices = ChatSlicesText | ChatSlicesToolCall | ChatSlicesToolCallResult | ChatSlicesSticker

export interface ChatAssistantMessage extends AssistantMessage {
  slices: ChatSlices[]
  tool_results: {
    id: string
    isError?: boolean
    result?: string | CommonContentPart[]
  }[]
  categorization?: {
    speech: string
    reasoning: string
  }
}

export type ChatMessage = ChatAssistantMessage | SystemMessage | ToolMessage | UserMessage

export interface ErrorMessage {
  role: 'error'
  content: string
}

export interface ContextMessage extends ContextUpdate<Record<string, unknown>, unknown> {
  metadata?: {
    source: MetadataEventSource
  }
  createdAt: number
}

export type ChatHistoryItem = (ChatMessage | ErrorMessage) & { context?: ContextMessage } & { createdAt?: number, id?: string }

export interface ChatStreamEventContext {
  /** Stable correlation id shared by every hook emitted for one user turn. */
  turnId: string
  message: ChatHistoryItem
  contexts: Record<string, ContextMessage[]>
  composedMessage: Array<Message>
  input?: WebSocketEventInputs
}

export type ChatStreamEvent
  = | { type: 'before-compose', message: string, sessionId: string, context: Omit<ChatStreamEventContext, 'composedMessage'> }
    | { type: 'after-compose', message: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'before-send', message: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'after-send', message: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'token-literal', literal: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'token-special', special: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'stream-end', sessionId: string, context: ChatStreamEventContext }
    | { type: 'assistant-end', message: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'assistant-message', message: ChatAssistantMessage, sessionId: string, messageText: string, context: ChatStreamEventContext }

export type StreamingAssistantMessage = ChatAssistantMessage & { context?: ContextMessage } & { createdAt?: number, id?: string }
