<script setup lang="ts">
import type { ChatProvider } from '@xsai-ext/providers/utils'

import { errorMessageFrom } from '@moeru/std'
import { isStageTamagotchi } from '@proj-airi/stage-shared'
import { StickerPicker } from '@proj-airi/stage-ui/components/scenarios/chat'
import { HearingConfig } from '@proj-airi/stage-ui/components/scenarios/dialogs/audio-input/index'
import { useAudioAnalyzer } from '@proj-airi/stage-ui/composables'
import { useAudioContext } from '@proj-airi/stage-ui/stores/audio'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { formatStickerMarker, useStickersStore } from '@proj-airi/stage-ui/stores/modules/stickers'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { useSettings, useSettingsAudioDevice } from '@proj-airi/stage-ui/stores/settings'
import { BasicTextarea } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import IndicatorMicVolume from './IndicatorMicVolume.vue'

import { useTranscriptions } from '../../composables/use-transcriptions'
import { useStopSpeakingButton } from '../../composables/useStopSpeakingButton'

interface PendingImage {
  id: string
  data: string
  mimeType: string
  previewUrl: string
}

const messageInput = ref<string>('')
const hearingPopoverOpen = ref(false)
const stickerPickerOpen = ref(false)
const isComposing = ref(false)
const pendingImages = ref<PendingImage[]>([])
const dragOver = ref(false)
const DOUBLE_ENTER_INTERVAL_MS = 300
const TRAILING_NEWLINES_REGEX = /[\r\n]+$/
const SEND_MODES = ['enter', 'ctrl-enter', 'double-enter'] as const
type SendMode = (typeof SEND_MODES)[number]
const sendMode = useLocalStorage<SendMode>('ui/chat/settings/send-mode', 'enter')
const lastEnterTime = ref(0)

const providersStore = useProvidersStore()
const stickersStore = useStickersStore()
const { activeProvider, activeModel } = storeToRefs(useConsciousnessStore())
const { themeColorsHueDynamic } = storeToRefs(useSettings())

const { askPermission } = useSettingsAudioDevice()
const { enabled, stream } = storeToRefs(useSettingsAudioDevice())
const chatOrchestrator = useChatOrchestratorStore()
const chatSession = useChatSessionStore()
const { ingest, onAfterMessageComposed } = chatOrchestrator
const { messages } = storeToRefs(chatSession)
const { audioContext } = useAudioContext()
const { t } = useI18n()
const sendModeLabels = computed<Record<SendMode, string>>(() => ({
  'enter': t('stage.send-mode.enter'),
  'ctrl-enter': t('stage.send-mode.ctrl-enter'),
  'double-enter': t('stage.send-mode.double-enter'),
}))

const { isListening, startStreamingTranscription, stopStreamingTranscription, autoSendEnabled } = useTranscriptions(
  {
    messageInputRef: messageInput,
    sendMessage: handleSend,
    isStageTamagotchi,
  },
)
const { showStopSpeakingButton, stopSpeakingFromChat } = useStopSpeakingButton()

function readFileAsBase64(file: File): Promise<{ data: string, mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      resolve({ data: base64, mimeType: file.type })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function addImageFiles(files: File[]) {
  const imageFiles = files.filter(f => f.type.startsWith('image/'))
  for (const file of imageFiles) {
    const { data, mimeType } = await readFileAsBase64(file)
    pendingImages.value.push({
      id: crypto.randomUUID(),
      data,
      mimeType,
      previewUrl: URL.createObjectURL(file),
    })
  }
}

function removePendingImage(id: string) {
  const idx = pendingImages.value.findIndex(img => img.id === id)
  if (idx !== -1) {
    URL.revokeObjectURL(pendingImages.value[idx].previewUrl)
    pendingImages.value.splice(idx, 1)
  }
}

function handlePasteFile(files: File[]) {
  addImageFiles(files)
}

function handleDrop(e: DragEvent) {
  dragOver.value = false
  if (e.dataTransfer?.files.length)
    addImageFiles(Array.from(e.dataTransfer.files))
}

function handleDragOver(e: DragEvent) {
  e.preventDefault()
  dragOver.value = true
}

function handleDragLeave() {
  dragOver.value = false
}

async function handleSend() {
  if ((!messageInput.value.trim() && pendingImages.value.length === 0) || isComposing.value) {
    return
  }

  const textToSend = messageInput.value
  const imagesToSend = [...pendingImages.value]
  messageInput.value = ''
  pendingImages.value = []

  try {
    const providerConfig = providersStore.getProviderConfig(activeProvider.value)

    await ingest(textToSend, {
      chatProvider: await providersStore.getProviderInstance(activeProvider.value) as ChatProvider,
      model: activeModel.value,
      providerConfig,
      ...(imagesToSend.length > 0 && {
        attachments: imagesToSend.map(img => ({
          type: 'image' as const,
          data: img.data,
          mimeType: img.mimeType,
        })),
      }),
    })

    for (const img of imagesToSend)
      URL.revokeObjectURL(img.previewUrl)
  }
  catch (error) {
    messageInput.value = [textToSend, messageInput.value.trim()].filter(Boolean).join(' ')
    pendingImages.value = imagesToSend
    chatSession.setSessionMessages(chatSession.activeSessionId, [
      ...messages.value.slice(0, -1),
      {
        role: 'error',
        content: errorMessageFrom(error) ?? 'Failed to send message',
      },
    ])
  }
}

function sendFromKeyboard() {
  messageInput.value = messageInput.value.replace(TRAILING_NEWLINES_REGEX, '')
  void handleSend()
}

function handleMessageInputKeydown(event: KeyboardEvent) {
  if (isComposing.value || event.key !== 'Enter')
    return

  const hasControl = event.ctrlKey || event.metaKey
  const hasShift = event.shiftKey

  switch (sendMode.value) {
    case 'enter':
      if (!hasShift && !hasControl) {
        event.preventDefault()
        sendFromKeyboard()
      }
      return
    case 'ctrl-enter':
      if (hasControl) {
        event.preventDefault()
        sendFromKeyboard()
      }
      return
    case 'double-enter':
      if (!hasShift && !hasControl) {
        const now = Date.now()
        if (now - lastEnterTime.value < DOUBLE_ENTER_INTERVAL_MS) {
          event.preventDefault()
          sendFromKeyboard()
          lastEnterTime.value = 0
        }
        else {
          lastEnterTime.value = now
        }
      }
  }
}

watch(hearingPopoverOpen, async (value) => {
  if (value) {
    await askPermission()
  }
})

onAfterMessageComposed(async () => {
})

const { startAnalyzer, stopAnalyzer } = useAudioAnalyzer()
let analyzerSource: MediaStreamAudioSourceNode | undefined

function teardownAnalyzer() {
  try {
    analyzerSource?.disconnect()
  }
  catch {}
  analyzerSource = undefined
  stopAnalyzer()
}

async function setupAnalyzer() {
  teardownAnalyzer()
  if (!hearingPopoverOpen.value || !enabled.value || !stream.value)
    return
  if (audioContext.state === 'suspended')
    await audioContext.resume()
  const analyser = startAnalyzer(audioContext)
  if (!analyser)
    return
  analyzerSource = audioContext.createMediaStreamSource(stream.value)
  analyzerSource.connect(analyser)
}

watch([enabled], () => {
  setupAnalyzer()
}, { immediate: true })

onUnmounted(() => {
  teardownAnalyzer()
  for (const img of pendingImages.value)
    URL.revokeObjectURL(img.previewUrl)
})

function handleInsertSticker(name: string) {
  stickerPickerOpen.value = false
  messageInput.value = messageInput.value + formatStickerMarker(name)
}

watch(sendMode, () => {
  lastEnterTime.value = 0
})
</script>

<template>
  <div h="<md:full" flex gap-2 class="ph-no-capture">
    <div
      :class="[
        'relative',
        'w-full',
        'bg-primary-200/20 dark:bg-primary-400/20',
        dragOver && 'ring-2 ring-primary-400 ring-inset',
      ]"
      @drop.prevent="handleDrop"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
    >
      <!-- Pending image preview strip -->
      <div v-if="pendingImages.length > 0" class="flex flex-wrap gap-2 px-3 pt-3">
        <div
          v-for="img in pendingImages" :key="img.id"
          :class="[
            'group relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg',
            'border border-neutral-200/60 dark:border-neutral-700/40',
          ]"
        >
          <img :src="img.previewUrl" class="h-full w-full object-cover">
          <button
            :class="[
              'absolute right-0.5 top-0.5 h-5 w-5 flex items-center justify-center rounded-full',
              'bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100',
            ]"
            @click="removePendingImage(img.id)"
          >
            <div class="i-ph:x-bold h-3 w-3" />
          </button>
        </div>
      </div>

      <BasicTextarea
        v-model="messageInput"
        :submit-on-enter="false"
        :placeholder="t('stage.message')"
        text="primary-600 dark:primary-100  placeholder:primary-500 dark:placeholder:primary-200"
        bg="transparent"
        min-h="[100px]" max-h="[300px]" w-full
        rounded-t-xl p-4 font-medium pb="[60px]"
        outline-none transition="all duration-250 ease-in-out placeholder:all placeholder:duration-250 placeholder:ease-in-out"
        :class="{
          'transition-colors-none placeholder:transition-colors-none': themeColorsHueDynamic,
        }"
        @keydown="handleMessageInputKeydown"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false"
        @paste-file="handlePasteFile"
      />

      <!-- Input configuration controls -->
      <div
        absolute bottom-2 left-2 z-10 flex items-center gap-2
      >
        <DropdownMenuRoot>
          <DropdownMenuTrigger as-child>
            <button
              :class="[
                'h-8 w-8 flex items-center justify-center rounded-md outline-none transition-all duration-200 active:scale-95',
                'text-lg text-neutral-500 dark:text-neutral-400',
              ]"
              :title="t('stage.send-mode.title')"
            >
              <div class="i-solar:keyboard-bold-duotone h-5 w-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent
              side="top"
              align="start"
              :side-offset="8"
              :class="[
                'z-50 min-w-[180px] rounded-xl border border-neutral-200/60 bg-neutral-50/90 p-1',
                'shadow-lg backdrop-blur-md dark:border-neutral-800/30 dark:bg-neutral-900/80',
                'flex flex-col gap-1',
              ]"
            >
              <DropdownMenuItem
                v-for="mode in SEND_MODES"
                :key="mode"
                :class="[
                  'w-full flex cursor-pointer items-center rounded-lg px-3 py-2 text-xs outline-none transition-colors',
                  'hover:bg-primary-100/60 dark:hover:bg-primary-900/40',
                  sendMode === mode ? 'bg-primary-100/60 text-primary-600 font-medium dark:bg-primary-900/40 dark:text-primary-300' : 'text-neutral-600 dark:text-neutral-300',
                ]"
                @select="sendMode = mode"
              >
                <div class="mr-2 h-4 w-4 flex items-center justify-center">
                  <div v-if="sendMode === mode" class="i-ph:check-bold h-4 w-4" />
                </div>
                <span>{{ sendModeLabels[mode] }}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>

        <!-- Sticker Picker -->
        <PopoverRoot v-if="stickersStore.configured" v-model:open="stickerPickerOpen">
          <PopoverTrigger as-child>
            <button
              :class="[
                'h-8 w-8 flex items-center justify-center rounded-md outline-none',
                'transition-all duration-200 active:scale-95',
              ]"
              text="lg neutral-500 dark:neutral-400"
              :title="t('stage.sticker-picker.title')"
            >
              <div class="i-solar:sticker-smile-circle-2-bold-duotone h-5 w-5" />
            </button>
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent
              side="top"
              align="start"
              :side-offset="8"
              :class="[
                'z-50 w-[296px] rounded-xl shadow-lg',
                'bg-white/95 backdrop-blur-md dark:bg-neutral-900/95',
                'border border-neutral-200/60 dark:border-neutral-700/40',
              ]"
            >
              <StickerPicker @select="handleInsertSticker" />
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>

        <!-- Microphone icon button -->
        <PopoverRoot v-model:open="hearingPopoverOpen">
          <PopoverTrigger as-child>
            <button
              :class="[
                'h-8 w-8 flex items-center justify-center rounded-md outline-none',
                'transition-all duration-200 active:scale-95',
              ]"
              text="lg neutral-500 dark:neutral-400"
              :title="t('settings.hearing.title')"
            >
              <Transition name="fade" mode="out-in">
                <IndicatorMicVolume v-if="enabled" class="h-5 w-5" :color-class="isListening ? undefined : 'text-neutral-500 dark:text-neutral-400'" />
                <div v-else class="i-ph:microphone-slash h-5 w-5" />
              </Transition>
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            :side-offset="8"
            :class="[
              'w-72 max-w-[18rem] rounded-xl border border-neutral-200/60 bg-neutral-50/90 p-4',
              'shadow-lg backdrop-blur-md dark:border-neutral-800/30 dark:bg-neutral-900/80',
              'flex flex-col gap-3',
            ]"
          >
            <HearingConfig
              v-model:auto-send="autoSendEnabled"
              :transcription="isListening"
              :granted="true"
              @toggle-transcription="() => isListening ? stopStreamingTranscription() : startStreamingTranscription()"
            />
          </PopoverContent>
        </PopoverRoot>
      </div>

      <div
        absolute bottom-2 right-2 z-10 flex items-center gap-1
      >
        <button
          v-if="showStopSpeakingButton"
          data-testid="stop-speaking-button"
          :class="[
            'h-8 w-8 flex items-center justify-center rounded-md outline-none',
            'text-lg text-neutral-500 transition-all duration-200 active:scale-95 dark:text-neutral-400',
            'hover:bg-primary-100/60 hover:text-primary-600 dark:hover:bg-primary-900/40 dark:hover:text-primary-300',
          ]"
          title="Stop speaking"
          aria-label="Stop speaking"
          @click="stopSpeakingFromChat"
        >
          <div class="i-solar:stop-circle-bold-duotone h-5 w-5" />
        </button>
      </div>
    </div>
  </div>
</template>
