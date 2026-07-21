<script setup lang="ts">
import type { MemoryKind } from '../../../../stores/chat/memory'
import type { MemoryItemRow } from '../../../../stores/chat/memory/schema'

import { errorMessageFrom } from '@moeru/std'
import { storeToRefs } from 'pinia'
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'

import RadioCardManySelect from '../../../menu/radio-card-many-select.vue'
import RadioCardSimple from '../../../menu/radio-card-simple.vue'

import { useChatMaintenanceStore } from '../../../../stores/chat/maintenance'
import { useMemoryService } from '../../../../stores/chat/memory'
import { useAiriCardStore } from '../../../../stores/modules/airi-card'
import { useMemoryStore } from '../../../../stores/modules/memory'
import { useProvidersStore } from '../../../../stores/providers'

const { t } = useI18n()

const providersStore = useProvidersStore()
const cardStore = useAiriCardStore()
const memoryStore = useMemoryStore()
const memoryService = useMemoryService()
const maintenanceStore = useChatMaintenanceStore()

const { persistedChatProvidersMetadata } = storeToRefs(providersStore)
const {
  activeProvider,
  activeModel,
  customModelName,
  modelSearchQuery,
  supportsModelListing,
  providerModels,
  triggerRounds,
  retainRounds,
  autoConsolidationEnabled,
  consolidationPrompt,
} = storeToRefs(memoryStore)

const kindFilter = ref<'all' | MemoryKind>('all')
const items = ref<MemoryItemRow[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)

type ConsolidateFeedback
  = | { type: 'done', rounds: number, memories: number }
    | { type: 'nothing' }
    | { type: 'not-configured' }
    | { type: 'busy' }
    | { type: 'error', message: string }

const consolidating = ref(false)
const consolidateFeedback = ref<ConsolidateFeedback | null>(null)

type UndoFeedback
  = | { type: 'done', rounds: number, remaining: number }
    | { type: 'nothing' }
    | { type: 'busy' }
    | { type: 'error', message: string }

const undoing = ref(false)
const undoFeedback = ref<UndoFeedback | null>(null)
// How many passes can still be undone for the active session; drives the undo
// button's enabled state and the "N undoable" hint.
const undoableCount = ref(0)

async function refreshUndoableCount() {
  try {
    undoableCount.value = await maintenanceStore.undoableConsolidationCount()
  }
  catch {
    // Leave the last known count; the DB may not have opened yet and the next
    // consolidate/undo refresh will correct it.
  }
}

async function refresh() {
  loading.value = true
  loadError.value = null
  try {
    const characterId = cardStore.activeCardId || 'default'
    const filter: { characterId: string, kind?: 'long' | 'short' } = { characterId }
    if (kindFilter.value !== 'all')
      filter.kind = kindFilter.value
    items.value = await memoryService.listMemories(filter)
  }
  catch (error) {
    // Surface init/query failures instead of leaving an empty list that looks
    // like "no memories"; the DB may simply not have opened yet.
    loadError.value = String(error)
  }
  finally {
    loading.value = false
  }
}

async function consolidateNow() {
  if (consolidating.value || undoing.value)
    return
  consolidating.value = true
  consolidateFeedback.value = null
  undoFeedback.value = null
  try {
    const result = await maintenanceStore.consolidateSessionNow()
    if (result.status === 'done') {
      consolidateFeedback.value = { type: 'done', rounds: result.archivedRounds, memories: result.memoryCount }
      await refresh()
    }
    else if (result.status === 'nothing-to-archive') {
      consolidateFeedback.value = { type: 'nothing' }
    }
    else if (result.status === 'not-configured') {
      consolidateFeedback.value = { type: 'not-configured' }
    }
    else {
      consolidateFeedback.value = { type: 'busy' }
    }
  }
  catch (error) {
    consolidateFeedback.value = { type: 'error', message: errorMessageFrom(error) ?? String(error) }
  }
  finally {
    consolidating.value = false
    await refreshUndoableCount()
  }
}

async function undoLast() {
  if (consolidating.value || undoing.value)
    return
  undoing.value = true
  undoFeedback.value = null
  consolidateFeedback.value = null
  try {
    const result = await maintenanceStore.undoLastConsolidation()
    if (result.status === 'done') {
      undoFeedback.value = { type: 'done', rounds: result.restoredRounds, remaining: result.remainingUndoable }
      await refresh()
    }
    else if (result.status === 'nothing-to-undo') {
      undoFeedback.value = { type: 'nothing' }
    }
    else {
      undoFeedback.value = { type: 'busy' }
    }
  }
  catch (error) {
    undoFeedback.value = { type: 'error', message: errorMessageFrom(error) ?? String(error) }
  }
  finally {
    undoing.value = false
    await refreshUndoableCount()
  }
}

// NOTICE: model-search sub-labels reuse the consciousness namespace — they are
// generic ("search", "no models", "expand") and identical across model pickers,
// so duplicating them under a memory namespace would only add translation debt.
const consciousnessSelect = 'settings.pages.modules.consciousness.sections.section.provider-model-selection'

watch(activeProvider, async (provider, oldProvider) => {
  if (!provider)
    return
  if (oldProvider !== undefined && oldProvider !== provider)
    activeModel.value = ''
  await memoryStore.loadModelsForProvider(provider)
}, { immediate: true })

async function removeItem(id: string) {
  await memoryService.removeMemory(id)
  items.value = items.value.filter(item => item.id !== id)
}

watch(kindFilter, refresh)

onMounted(async () => {
  await refresh()
  await refreshUndoableCount()
})
</script>

<template>
  <div :class="['flex flex-col gap-4']">
    <!-- Summarization model selection -->
    <div :class="['rounded-xl p-4', 'bg-neutral-50 dark:bg-[rgba(0,0,0,0.3)]', 'flex flex-col gap-4']">
      <div>
        <h2 :class="['text-lg md:text-2xl', 'text-neutral-700 dark:text-neutral-300']">
          {{ t('settings.pages.modules.memory.summarization-model.title') }}
        </h2>
        <div :class="['text-neutral-400 dark:text-neutral-400']">
          {{ t('settings.pages.modules.memory.summarization-model.description') }}
        </div>
      </div>

      <fieldset
        v-if="persistedChatProvidersMetadata.length > 0"
        :class="['flex flex-row gap-4', 'min-w-0 overflow-x-auto scroll-smooth']"
        role="radiogroup"
      >
        <RadioCardSimple
          v-for="metadata in persistedChatProvidersMetadata"
          :id="metadata.id"
          :key="metadata.id"
          v-model="activeProvider"
          name="memory-provider"
          :value="metadata.id"
          :title="metadata.localizedName || 'Unknown'"
          :description="metadata.localizedDescription"
        />
      </fieldset>
      <RouterLink
        v-else
        to="/settings/providers"
        :class="['flex items-center gap-3 rounded-lg p-4', 'border-2 border-dashed border-neutral-200 dark:border-neutral-800', 'bg-neutral-50 dark:bg-neutral-800']"
      >
        <div i-solar:warning-circle-line-duotone :class="['text-2xl text-amber-500 dark:text-amber-400']" />
        <span>{{ t('settings.pages.modules.memory.no-provider') }}</span>
        <div i-solar:arrow-right-line-duotone :class="['ml-auto text-xl text-neutral-400 dark:text-neutral-500']" />
      </RouterLink>

      <!-- Model picker (only when a provider that lists models is selected) -->
      <template v-if="activeProvider && supportsModelListing">
        <RadioCardManySelect
          v-model="activeModel"
          v-model:search-query="modelSearchQuery"
          :items="providerModels"
          :searchable="true"
          :allow-custom="true"
          :search-placeholder="t(`${consciousnessSelect}.search_placeholder`)"
          :search-no-results-title="t(`${consciousnessSelect}.no_search_results`)"
          :search-no-results-description="t(`${consciousnessSelect}.no_search_results_description`, { query: modelSearchQuery })"
          :search-results-text="t(`${consciousnessSelect}.search_results`, { count: '{count}', total: '{total}' })"
          :custom-input-placeholder="t(`${consciousnessSelect}.custom_model_placeholder`)"
          :expand-button-text="t(`${consciousnessSelect}.expand`)"
          :collapse-button-text="t(`${consciousnessSelect}.collapse`)"
          @update:custom-value="(value: string) => customModelName = value"
        />
      </template>
      <!-- Provider without model listing: free-typed model id -->
      <div v-else-if="activeProvider && !supportsModelListing">
        <label :class="['mb-1 block text-sm font-medium']">
          {{ t(`${consciousnessSelect}.manual_model_name`) }}
        </label>
        <input
          v-model="activeModel"
          type="text"
          :class="['w-full rounded px-3 py-2', 'border border-neutral-300 dark:border-neutral-700', 'bg-white dark:bg-neutral-900']"
          :placeholder="t(`${consciousnessSelect}.manual_model_placeholder`)"
        >
      </div>
    </div>

    <!-- Consolidation cadence -->
    <div :class="['rounded-xl p-4', 'bg-neutral-50 dark:bg-[rgba(0,0,0,0.3)]', 'flex flex-col gap-4']">
      <div>
        <h2 :class="['text-lg md:text-2xl', 'text-neutral-700 dark:text-neutral-300']">
          {{ t('settings.pages.modules.memory.cadence.title') }}
        </h2>
      </div>
      <label :class="['flex items-start gap-3', 'cursor-pointer select-none']">
        <input
          v-model="autoConsolidationEnabled"
          type="checkbox"
          :class="['mt-1']"
        >
        <span :class="['flex flex-col gap-0.5']">
          <span :class="['text-sm font-medium']">{{ t('settings.pages.modules.memory.cadence.auto-label') }}</span>
          <span :class="['text-xs text-neutral-400 dark:text-neutral-500']">{{ t('settings.pages.modules.memory.cadence.auto-desc') }}</span>
        </span>
      </label>
      <div v-if="autoConsolidationEnabled" :class="['flex flex-col gap-4 md:flex-row']">
        <label :class="['flex flex-1 flex-col gap-1']">
          <span :class="['text-sm font-medium']">{{ t('settings.pages.modules.memory.cadence.trigger-label') }}</span>
          <input
            v-model.number="triggerRounds"
            type="number" min="1"
            :class="['w-full rounded px-3 py-2', 'border border-neutral-300 dark:border-neutral-700', 'bg-white dark:bg-neutral-900']"
          >
          <span :class="['text-xs text-neutral-400 dark:text-neutral-500']">{{ t('settings.pages.modules.memory.cadence.trigger-desc') }}</span>
        </label>
        <label :class="['flex flex-1 flex-col gap-1']">
          <span :class="['text-sm font-medium']">{{ t('settings.pages.modules.memory.cadence.retain-label') }}</span>
          <input
            v-model.number="retainRounds"
            type="number" min="1"
            :class="['w-full rounded px-3 py-2', 'border border-neutral-300 dark:border-neutral-700', 'bg-white dark:bg-neutral-900']"
          >
          <span :class="['text-xs text-neutral-400 dark:text-neutral-500']">{{ t('settings.pages.modules.memory.cadence.retain-desc') }}</span>
        </label>
      </div>

      <!-- User guidance appended to the consolidation system prompt -->
      <label :class="['flex flex-col gap-1 border-t pt-4', 'border-neutral-200 dark:border-neutral-800']">
        <span :class="['text-sm font-medium']">{{ t('settings.pages.modules.memory.prompt.title') }}</span>
        <span :class="['text-xs text-neutral-400 dark:text-neutral-500']">{{ t('settings.pages.modules.memory.prompt.description') }}</span>
        <textarea
          v-model="consolidationPrompt"
          rows="3"
          :placeholder="t('settings.pages.modules.memory.prompt.placeholder')"
          :class="['w-full resize-y rounded px-3 py-2', 'border border-neutral-300 dark:border-neutral-700', 'bg-white dark:bg-neutral-900']"
        />
      </label>

      <!-- Manual consolidation -->
      <div :class="['flex flex-col gap-2 border-t pt-4', 'border-neutral-200 dark:border-neutral-800']">
        <div :class="['flex flex-col gap-3 md:flex-row md:items-center md:justify-between']">
          <div :class="['flex flex-col gap-1']">
            <span :class="['text-sm font-medium']">{{ t('settings.pages.modules.memory.manual.title') }}</span>
            <span :class="['text-xs text-neutral-400 dark:text-neutral-500']">{{ t('settings.pages.modules.memory.manual.description') }}</span>
          </div>
          <div :class="['flex items-center gap-2']">
            <button
              type="button"
              :disabled="consolidating || undoing"
              :class="[
                'flex items-center gap-2 rounded-lg px-4 py-2',
                'bg-primary-500 text-white hover:bg-primary-600 dark:bg-primary-600 dark:hover:bg-primary-500',
                'disabled:cursor-not-allowed disabled:opacity-60',
              ]"
              @click="consolidateNow"
            >
              <div :class="[consolidating ? 'i-solar:refresh-line-duotone animate-spin' : 'i-solar:archive-down-minimlistic-bold-duotone', 'text-base']" />
              {{ consolidating ? t('settings.pages.modules.memory.manual.running') : t('settings.pages.modules.memory.manual.button') }}
            </button>
            <button
              type="button"
              :disabled="consolidating || undoing || undoableCount === 0"
              :class="[
                'flex items-center gap-2 rounded-lg px-4 py-2',
                'bg-neutral-200 text-neutral-700 hover:bg-neutral-300 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700',
                'disabled:cursor-not-allowed disabled:opacity-60',
              ]"
              @click="undoLast"
            >
              <div :class="[undoing ? 'i-solar:refresh-line-duotone animate-spin' : 'i-solar:undo-left-round-bold-duotone', 'text-base']" />
              {{ undoing ? t('settings.pages.modules.memory.undo.running') : t('settings.pages.modules.memory.undo.button') }}
            </button>
          </div>
        </div>
        <div v-if="undoableCount > 0" :class="['text-xs text-neutral-400 dark:text-neutral-500']">
          {{ t('settings.pages.modules.memory.undo.available', { count: undoableCount }) }}
        </div>
        <div v-if="consolidateFeedback" :class="['text-sm']">
          <span v-if="consolidateFeedback.type === 'done'" :class="['text-emerald-600 dark:text-emerald-400']">
            {{ t('settings.pages.modules.memory.manual.done', { rounds: consolidateFeedback.rounds, memories: consolidateFeedback.memories }) }}
          </span>
          <span v-else-if="consolidateFeedback.type === 'nothing'" :class="['text-neutral-500 dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory.manual.nothing') }}
          </span>
          <span v-else-if="consolidateFeedback.type === 'not-configured'" :class="['text-amber-600 dark:text-amber-400']">
            {{ t('settings.pages.modules.memory.no-provider') }}
          </span>
          <span v-else-if="consolidateFeedback.type === 'busy'" :class="['text-neutral-500 dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory.manual.busy') }}
          </span>
          <span v-else :class="['text-red-500 dark:text-red-400']">
            {{ t('settings.pages.modules.memory.manual.error', { error: consolidateFeedback.message }) }}
          </span>
        </div>
        <div v-if="undoFeedback" :class="['text-sm']">
          <span v-if="undoFeedback.type === 'done'" :class="['text-emerald-600 dark:text-emerald-400']">
            {{ t('settings.pages.modules.memory.undo.done', { rounds: undoFeedback.rounds, remaining: undoFeedback.remaining }) }}
          </span>
          <span v-else-if="undoFeedback.type === 'nothing'" :class="['text-neutral-500 dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory.undo.nothing') }}
          </span>
          <span v-else-if="undoFeedback.type === 'busy'" :class="['text-neutral-500 dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory.manual.busy') }}
          </span>
          <span v-else :class="['text-red-500 dark:text-red-400']">
            {{ t('settings.pages.modules.memory.undo.error', { error: undoFeedback.message }) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Stored memories, long and short together, filterable by kind -->
    <div :class="['rounded-xl p-4', 'bg-neutral-50 dark:bg-[rgba(0,0,0,0.3)]', 'flex flex-col gap-4']">
      <div :class="['flex items-center justify-between gap-2']">
        <h2 :class="['text-lg md:text-2xl', 'text-neutral-700 dark:text-neutral-300']">
          {{ t('settings.pages.modules.memory.list.title') }}
        </h2>
        <div :class="['flex items-center gap-1']">
          <button
            v-for="kind in (['all', 'long', 'short'] as const)"
            :key="kind"
            type="button"
            :class="[
              'rounded-full px-3 py-1 text-xs',
              kindFilter === kind
                ? 'bg-primary-500 text-white dark:bg-primary-600'
                : 'bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700',
            ]"
            @click="kindFilter = kind"
          >
            {{ t(`settings.pages.modules.memory.kinds.${kind}`) }}
          </button>
          <button
            type="button"
            :class="['rounded p-2', 'text-neutral-500 dark:text-neutral-300', 'hover:bg-neutral-200 dark:hover:bg-neutral-700/60']"
            :title="t('settings.pages.modules.memory.list.refresh')"
            @click="refresh"
          >
            <div i-solar:refresh-line-duotone :class="['text-base', loading ? 'animate-spin' : '']" />
          </button>
        </div>
      </div>

      <div v-if="loadError" :class="['text-sm text-red-500 dark:text-red-400']">
        {{ loadError }}
      </div>
      <div v-else-if="!loading && items.length === 0" :class="['text-sm text-neutral-400 dark:text-neutral-500']">
        {{ t('settings.pages.modules.memory.list.empty') }}
      </div>
      <ul v-else :class="['flex flex-col gap-2']">
        <li
          v-for="item in items"
          :key="item.id"
          :class="['rounded-lg p-3', 'bg-white dark:bg-neutral-900/40', 'flex flex-col gap-2']"
        >
          <div :class="['flex items-start justify-between gap-2']">
            <div :class="['text-sm text-neutral-700 dark:text-neutral-200']">
              {{ item.content }}
            </div>
            <button
              type="button"
              :class="[
                'shrink-0 rounded p-1',
                'text-neutral-400 hover:text-red-500',
                'dark:text-neutral-500 dark:hover:text-red-400',
                'transition-colors',
              ]"
              :title="t('settings.pages.modules.memory.list.delete')"
              @click="removeItem(item.id)"
            >
              <div :class="['text-sm i-solar:trash-bin-trash-bold-duotone']" />
            </button>
          </div>
          <div :class="['flex flex-wrap items-center gap-2', 'text-xs text-neutral-400 dark:text-neutral-500']">
            <span
              :class="[
                'rounded px-2 py-0.5',
                item.kind === 'long'
                  ? 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300'
                  : 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
              ]"
            >
              {{ t(`settings.pages.modules.memory.kinds.${item.kind === 'long' ? 'long' : 'short'}`) }}
            </span>
            <span :class="['rounded bg-primary-100 px-2 py-0.5 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300']">
              {{ t('settings.pages.modules.memory.list.importance') }} {{ item.importance.toFixed(2) }}
            </span>
            <span v-for="kw in item.keywords" :key="kw" :class="['rounded bg-neutral-100 px-2 py-0.5 dark:bg-neutral-800']">
              {{ kw }}
            </span>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
