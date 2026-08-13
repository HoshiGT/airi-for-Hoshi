<script setup lang="ts">
import type { ChatSessionMeta } from '../../../../types/chat-session'

import { useResizeObserver, useScreenSafeArea } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { DrawerContent, DrawerHandle, DrawerOverlay, DrawerPortal, DrawerRoot, DrawerTitle } from 'vaul-vue'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'

import { useAnalytics } from '../../../../composables/use-analytics'
import { useBreakpoints } from '../../../../composables/use-breakpoints'
import { extractMessageText } from '../../../../libs/chat-sync'
import { useAuthStore } from '../../../../stores/auth'
import { useChatSessionStore } from '../../../../stores/chat/session-store'
import { useAiriCardStore } from '../../../../stores/modules/airi-card'
import { useConsciousnessStore } from '../../../../stores/modules/consciousness'

const showDialog = defineModel({ type: Boolean, default: false, required: false })

const { isDesktop } = useBreakpoints()
const screenSafeArea = useScreenSafeArea()
const { t } = useI18n()

const chatSession = useChatSessionStore()
const { sessionMetas, sessionMessages, activeSessionId } = storeToRefs(chatSession)
const { activeCardId } = storeToRefs(useAiriCardStore())
const { userId } = storeToRefs(useAuthStore())
const { activeModel } = storeToRefs(useConsciousnessStore())
const { trackChatSessionSelected, trackChatSessionStarted } = useAnalytics()

const isCreatingSession = ref(false)
const isPurging = ref(false)

/**
 * How long the undo affordance stays on screen after deleting a conversation.
 * Long enough to notice and react to a misclick without parking a stale toast.
 */
const DELETE_UNDO_WINDOW_MS = 8000

useResizeObserver(document.documentElement, () => screenSafeArea.update())
onMounted(() => screenSafeArea.update())

interface SessionRow {
  meta: ChatSessionMeta
  preview: string
  isActive: boolean
  updatedAtLabel: string
}

const ownedSessions = computed(() => {
  const effectiveUserId = userId.value || 'local'
  return Object.values(sessionMetas.value).filter(meta => meta.userId === effectiveUserId)
})

/**
 * Resolved previews keyed by session id.
 *
 * `rows` depends on `sessionMessages`, so without this every message mutation
 * anywhere (each streamed turn, each persist) rescans the message list of every
 * conversation in the drawer. Only successful lookups are cached — an empty
 * conversation must stay uncached so its first real message can still surface.
 * Cleared whenever the drawer opens, which is also what picks up first messages
 * that changed underneath (memory consolidation trimming the oldest rounds).
 */
const previewCache = new Map<string, string>()

/**
 * Pull a 1-line preview from the first non-system message; falls back to the
 * stored title or a generic placeholder when nothing readable is available.
 *
 * Before:
 * - messages: [system, { role: 'user', content: 'Tell me about the moon today' }, ...]
 *
 * After:
 * - "Tell me about the moon today"
 */
function previewFor(meta: ChatSessionMeta): string {
  if (meta.title)
    return meta.title

  const cached = previewCache.get(meta.sessionId)
  if (cached !== undefined)
    return cached

  const messages = sessionMessages.value[meta.sessionId] ?? []
  for (const message of messages) {
    if (message.role === 'system')
      continue
    const trimmed = extractMessageText(message).replace(/\s+/g, ' ').trim()
    if (trimmed) {
      const preview = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed
      previewCache.set(meta.sessionId, preview)
      return preview
    }
  }

  return t('stage.chat.sessions.new-chat-fallback')
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['week', 604_800_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
]

/**
 * Format an epoch ms timestamp as a coarse relative label like "3 minutes ago".
 *
 * Before:
 * - Date.now() - 5 * 60 * 1000
 *
 * After:
 * - "5 minutes ago"
 */
function formatUpdatedAt(ts: number): string {
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const delta = ts - Date.now()
  const abs = Math.abs(delta)
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) {
      const value = Math.round(delta / ms)
      return formatter.format(value, unit)
    }
  }
  return formatter.format(0, 'second')
}

const rows = computed<SessionRow[]>(() => {
  const list = ownedSessions.value
    .map<SessionRow>(meta => ({
      meta,
      preview: previewFor(meta),
      isActive: meta.sessionId === activeSessionId.value,
      updatedAtLabel: formatUpdatedAt(meta.updatedAt),
    }))
  list.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
  return list
})

async function selectSession(sessionId: string) {
  const selectedRow = rows.value.find(row => row.meta.sessionId === sessionId)
  if (sessionId !== activeSessionId.value && selectedRow) {
    trackChatSessionSelected({
      source: 'sessions_drawer',
      message_count: (sessionMessages.value[sessionId] ?? []).filter(message => message.role !== 'system').length,
      cloud_synced: !!selectedRow.meta.cloudChatId,
    })
  }
  chatSession.setActiveSession(sessionId)
  if (!isDesktop.value)
    showDialog.value = false
}

async function startNewSession() {
  if (isCreatingSession.value)
    return
  isCreatingSession.value = true
  try {
    const characterId = activeCardId.value || 'default'
    await chatSession.createSession(characterId, { setActive: true })
    trackChatSessionStarted(activeModel.value || 'unknown')
    if (!isDesktop.value)
      showDialog.value = false
  }
  finally {
    isCreatingSession.value = false
  }
}

async function purgeEmpty() {
  if (isPurging.value)
    return
  isPurging.value = true
  try {
    await chatSession.purgeEmptySessions()
  }
  finally {
    isPurging.value = false
  }
}

/**
 * Delete a conversation, but hand the user an undo before it is really gone.
 *
 * `deleteSession` returns everything needed to put it back, so the toast holds
 * that payload for its lifetime. Once the toast expires the backup is dropped
 * with it and the deletion is final (the IDB record and any cloud row are
 * already gone at that point).
 */
async function deleteRow(event: Event, sessionId: string) {
  event.stopPropagation()
  const backup = await chatSession.deleteSession(sessionId)
  if (!backup)
    return

  toast(t('stage.chat.sessions.deleted-toast'), {
    duration: DELETE_UNDO_WINDOW_MS,
    action: {
      label: t('stage.chat.sessions.undo-delete'),
      onClick: () => {
        void chatSession.restoreSession(backup)
      },
    },
  })
}

// Inline rename state. Only one row is editable at a time, keyed by session id.
const renamingSessionId = ref<string | null>(null)
const renameDraft = ref('')
const renameInputRef = ref<HTMLInputElement[] | HTMLInputElement | null>(null)

async function startRename(event: Event, row: SessionRow) {
  event.stopPropagation()
  renamingSessionId.value = row.meta.sessionId
  // Seed with the stored title only. Pre-filling the auto-generated preview
  // would silently freeze it as a real title on the first save.
  renameDraft.value = row.meta.title ?? ''
  await nextTick()
  const input = Array.isArray(renameInputRef.value) ? renameInputRef.value[0] : renameInputRef.value
  input?.focus()
  input?.select()
}

function cancelRename() {
  renamingSessionId.value = null
  renameDraft.value = ''
}

async function commitRename(sessionId: string) {
  if (renamingSessionId.value !== sessionId)
    return

  const draft = renameDraft.value
  cancelRename()
  await chatSession.renameSession(sessionId, draft)
}

let openGeneration = 0

watch(showDialog, async (open) => {
  if (!open)
    return
  // Reopening is the natural refresh point for previews whose source message may
  // have been rewritten (consolidation) since the last time we looked.
  previewCache.clear()
  openGeneration += 1
  const myGeneration = openGeneration
  void rows.value
  const knownSessionIds = ownedSessions.value.map(meta => meta.sessionId)
  const batchSize = 4
  for (let i = 0; i < knownSessionIds.length; i += batchSize) {
    if (myGeneration !== openGeneration || !showDialog.value)
      return
    await Promise.all(knownSessionIds.slice(i, i + batchSize).map(id => chatSession.loadSession(id)))
  }
})
</script>

<template>
  <!-- Desktop: inline sidebar panel -->
  <Transition v-if="isDesktop" name="sidebar">
    <div
      v-show="showDialog"
      :class="[
        'flex flex-col h-full overflow-hidden',
        'border-r border-neutral-200/60 dark:border-neutral-700/40',
        'bg-white/80 dark:bg-neutral-900/80 backdrop-blur-md',
      ]"
      :style="{ width: '260px', minWidth: '260px' }"
    >
      <div :class="['flex items-center justify-between px-3 pt-3 pb-2']">
        <span :class="['text-sm font-medium text-neutral-600 dark:text-neutral-300']">
          {{ t('stage.chat.sessions.title') }}
        </span>
        <div :class="['flex items-center gap-1']">
          <button
            :class="[
              'h-7 w-7 flex items-center justify-center rounded-lg',
              'text-neutral-400 hover:text-red-500 hover:bg-red-500/10',
              'dark:hover:text-red-400 dark:hover:bg-red-500/10',
              'transition-colors',
            ]"
            :disabled="isPurging"
            :title="t('stage.chat.sessions.purge-empty')"
            @click="purgeEmpty"
          >
            <div class="i-solar:broom-bold text-base" />
          </button>
          <button
            :class="[
              'h-7 w-7 flex items-center justify-center rounded-lg',
              'text-neutral-400 hover:text-primary-500 hover:bg-primary-50',
              'dark:hover:text-primary-300 dark:hover:bg-primary-900/30',
              'transition-colors',
            ]"
            :disabled="isCreatingSession"
            :title="t('stage.chat.sessions.new')"
            @click="startNewSession"
          >
            <div class="i-solar:add-circle-bold text-base" />
          </button>
          <button
            :class="[
              'h-7 w-7 flex items-center justify-center rounded-lg',
              'text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100',
              'dark:hover:text-neutral-200 dark:hover:bg-neutral-800',
              'transition-colors',
            ]"
            @click="showDialog = false"
          >
            <div class="i-solar:alt-arrow-left-bold text-base" />
          </button>
        </div>
      </div>
      <div :class="['flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin']">
        <div v-if="rows.length === 0" :class="['p-4 text-center text-xs text-neutral-400 dark:text-neutral-500']">
          {{ t('stage.chat.sessions.empty') }}
        </div>
        <div
          v-for="row in rows"
          :key="row.meta.sessionId"
          :class="[
            'group relative w-full rounded-lg mb-0.5',
            'transition-colors duration-150',
            row.isActive
              ? 'bg-primary-100/70 dark:bg-primary-900/40'
              : 'hover:bg-neutral-100/80 dark:hover:bg-neutral-800/60',
          ]"
        >
          <input
            v-if="renamingSessionId === row.meta.sessionId"
            ref="renameInputRef"
            v-model="renameDraft"
            type="text"
            :maxlength="80"
            :placeholder="t('stage.chat.sessions.rename-placeholder')"
            :class="[
              'w-full rounded-lg px-2.5 py-2 text-xs',
              'bg-white dark:bg-neutral-900',
              'border border-primary-300 dark:border-primary-700 outline-none',
            ]"
            @click.stop
            @keydown.enter="commitRename(row.meta.sessionId)"
            @keydown.esc="cancelRename()"
            @blur="commitRename(row.meta.sessionId)"
          >
          <template v-else>
            <button
              :class="['w-full text-left px-2.5 py-2 outline-none flex flex-col gap-0.5']"
              @click="selectSession(row.meta.sessionId)"
              @dblclick="startRename($event, row)"
            >
              <div :class="['flex items-center gap-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-200']">
                <span :class="['truncate flex-1']">{{ row.preview }}</span>
                <span
                  v-if="row.meta.cloudChatId"
                  :class="[
                    'shrink-0 text-[9px] uppercase tracking-wide rounded px-1 py-px',
                    'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
                  ]"
                  :title="t('stage.chat.sessions.cloud-badge')"
                >
                  cloud
                </span>
                <span :class="['w-12']" />
              </div>
              <div :class="['text-[10px] text-neutral-400 dark:text-neutral-500']">
                {{ row.updatedAtLabel }}
              </div>
            </button>
            <div
              :class="[
                'absolute right-1.5 top-1.5 flex items-center gap-0.5',
                'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
                'transition-opacity duration-150',
              ]"
            >
              <button
                :class="[
                  'h-6 w-6 flex items-center justify-center rounded-md',
                  'text-neutral-400 hover:text-primary-500 hover:bg-primary-500/10',
                ]"
                :title="t('stage.chat.sessions.rename')"
                @click="startRename($event, row)"
              >
                <div class="i-solar:pen-2-bold-duotone h-3.5 w-3.5" />
              </button>
              <button
                :class="[
                  'h-6 w-6 flex items-center justify-center rounded-md',
                  'text-neutral-400 hover:text-red-500 hover:bg-red-500/10',
                ]"
                :title="t('stage.chat.sessions.delete')"
                @click="deleteRow($event, row.meta.sessionId)"
              >
                <div class="i-solar:trash-bin-trash-bold-duotone h-3.5 w-3.5" />
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Transition>

  <!-- Mobile: bottom sheet (unchanged) -->
  <DrawerRoot v-else :open="showDialog" should-scale-background @update:open="value => showDialog = value">
    <DrawerPortal>
      <DrawerOverlay :class="['fixed inset-0']" />
      <DrawerContent
        :class="[
          'fixed bottom-0 left-0 right-0 z-1000',
          'mt-20 px-2 pt-3',
          'flex flex-col',
          'h-full max-h-[85%]',
          'rounded-t-[32px] outline-none backdrop-blur-md',
          'bg-neutral-50/95 dark:bg-neutral-900/95',
        ]"
        :style="{ paddingBottom: `${Math.max(Number.parseFloat(screenSafeArea.bottom.value.replace('px', '')), 24)}px` }"
      >
        <DrawerHandle :class="['[div&]:bg-neutral-400 [div&]:dark:bg-neutral-600']" />
        <div :class="['flex items-center justify-between px-4 pt-3 pb-2']">
          <DrawerTitle :class="['text-base font-medium text-neutral-700 dark:text-neutral-200']">
            {{ t('stage.chat.sessions.title') }}
          </DrawerTitle>
          <div :class="['flex items-center gap-2']">
            <button
              :class="[
                'rounded-lg px-3 py-1.5 text-xs font-medium',
                'bg-red-100/60 text-red-700 dark:bg-red-900/40 dark:text-red-200',
                'hover:bg-red-200/70 dark:hover:bg-red-800/50',
                'transition-colors',
              ]"
              :disabled="isPurging"
              :title="t('stage.chat.sessions.purge-empty')"
              @click="purgeEmpty"
            >
              {{ t('stage.chat.sessions.purge-empty') }}
            </button>
            <button
              :class="[
                'rounded-lg px-3 py-1.5 text-xs font-medium',
                'bg-primary-100/60 text-primary-700 dark:bg-primary-900/40 dark:text-primary-200',
                'hover:bg-primary-200/70 dark:hover:bg-primary-800/50',
                'transition-colors',
              ]"
              :disabled="isCreatingSession"
              @click="startNewSession"
            >
              {{ t('stage.chat.sessions.new') }}
            </button>
          </div>
        </div>
        <div :class="['flex-1 overflow-y-auto px-2 pb-2']">
          <div v-if="rows.length === 0" :class="['p-6 text-center text-sm text-neutral-500 dark:text-neutral-400']">
            {{ t('stage.chat.sessions.empty') }}
          </div>
          <div
            v-for="row in rows"
            :key="row.meta.sessionId"
            :class="[
              'group relative w-full rounded-xl mb-1',
              'transition-colors',
              row.isActive
                ? 'bg-primary-100/70 dark:bg-primary-900/40'
                : 'hover:bg-neutral-100/80 dark:hover:bg-neutral-800/60',
            ]"
          >
            <input
              v-if="renamingSessionId === row.meta.sessionId"
              ref="renameInputRef"
              v-model="renameDraft"
              type="text"
              :maxlength="80"
              :placeholder="t('stage.chat.sessions.rename-placeholder')"
              :class="[
                'w-full rounded-xl px-3 py-3 text-sm',
                'bg-white dark:bg-neutral-900',
                'border border-primary-300 dark:border-primary-700 outline-none',
              ]"
              @click.stop
              @keydown.enter="commitRename(row.meta.sessionId)"
              @keydown.esc="cancelRename()"
              @blur="commitRename(row.meta.sessionId)"
            >
            <template v-else>
              <button
                :class="['w-full text-left px-3 py-3 outline-none flex flex-col gap-1']"
                @click="selectSession(row.meta.sessionId)"
              >
                <div :class="['flex items-center gap-2 text-sm font-medium text-neutral-700 dark:text-neutral-200']">
                  <span :class="['truncate flex-1']">{{ row.preview }}</span>
                  <span
                    v-if="row.meta.cloudChatId"
                    :class="['shrink-0 text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5', 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300']"
                    :title="t('stage.chat.sessions.cloud-badge')"
                  >
                    cloud
                  </span>
                  <span :class="['w-14']" />
                </div>
                <div :class="['text-[11px] text-neutral-500 dark:text-neutral-400']">
                  {{ row.updatedAtLabel }}
                </div>
              </button>
              <div
                :class="[
                  'absolute right-2 top-2 flex items-center gap-1',
                  'opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100',
                  'transition-opacity duration-150',
                ]"
              >
                <button
                  :class="['h-7 w-7 flex items-center justify-center rounded-md', 'text-neutral-400 hover:text-primary-500 hover:bg-primary-500/10']"
                  :title="t('stage.chat.sessions.rename')"
                  @click="startRename($event, row)"
                >
                  <div class="i-solar:pen-2-bold-duotone h-4 w-4" />
                </button>
                <button
                  :class="['h-7 w-7 flex items-center justify-center rounded-md', 'text-neutral-400 hover:text-red-500 hover:bg-red-500/10']"
                  :title="t('stage.chat.sessions.delete')"
                  @click="deleteRow($event, row.meta.sessionId)"
                >
                  <div class="i-solar:trash-bin-trash-bold-duotone h-4 w-4" />
                </button>
              </div>
            </template>
          </div>
        </div>
      </DrawerContent>
    </DrawerPortal>
  </DrawerRoot>
</template>

<style scoped>
.sidebar-enter-active,
.sidebar-leave-active {
  transition: width 200ms ease, min-width 200ms ease, opacity 200ms ease;
}

.sidebar-enter-from,
.sidebar-leave-to {
  width: 0 !important;
  min-width: 0 !important;
  opacity: 0;
}
</style>
