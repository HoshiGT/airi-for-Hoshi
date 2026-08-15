import type { Card } from '@proj-airi/ccc'

import type { MemoryExport } from '../stores/chat/memory/repository'
import type { StickersExport } from '../stores/modules/stickers'
import type { ChatHistoryItem } from './chat'

export interface ChatSessionMeta {
  sessionId: string
  userId: string
  characterId: string
  title?: string
  createdAt: number
  updatedAt: number
  /**
   * Cloud chat id assigned by the server once this session is mirrored to the
   * `chats` table. Set during cloud reconcile, persisted across reloads. When
   * absent the session is local-only.
   */
  cloudChatId?: string
  /**
   * Highest server-assigned `seq` we have already merged into local messages
   * for this session. Used as `afterSeq` when calling `pullMessages`. Stays
   * undefined for local-only sessions.
   *
   * @default undefined
   */
  cloudMaxSeq?: number
}

export interface ChatSessionRecord {
  meta: ChatSessionMeta
  messages: ChatHistoryItem[]
}

export interface ChatCharacterSessionsIndex {
  activeSessionId: string
  sessions: Record<string, ChatSessionMeta>
}

export interface ChatSessionsIndex {
  userId: string
  characters: Record<string, ChatCharacterSessionsIndex>
}

/**
 * The chat backup file format.
 *
 * `cards`, `activeCardId`, and `memory` are optional sections: files written
 * before they existed (or hand-trimmed ones) still import — the importer
 * simply restores whatever sections are present.
 */
export interface ChatSessionsExport {
  format: 'chat-sessions-index:v1'
  index: ChatSessionsIndex
  sessions: Record<string, ChatSessionRecord>
  /**
   * Character cards keyed by the exporting install's card id — the same ids
   * `ChatSessionMeta.characterId` references, so importing the cards first
   * lets sessions keep their card linkage instead of being re-homed.
   */
  cards?: Record<string, Card>
  /**
   * The exporter's active card. After import the app switches to it (when it
   * exists locally) so the imported conversation surfaces without digging
   * through the card picker.
   */
  activeCardId?: string
  /** Consolidated memories + archived summaries + undo backups. */
  memory?: MemoryExport
  /**
   * The sticker library with its images inlined. Without it, `<|STICKER_名字|>`
   * markers in the imported messages would point at images the target install
   * does not have.
   */
  stickers?: StickersExport
}
