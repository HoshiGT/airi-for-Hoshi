<script setup lang="ts">
import type { ChatHistoryItem } from '@proj-airi/stage-ui/types/chat'

import { ChatHistory } from '@proj-airi/stage-ui/components'
import { ChatSessionsDrawer } from '@proj-airi/stage-ui/components/scenarios/chat'
import { useAnalytics } from '@proj-airi/stage-ui/composables/use-analytics'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'
import { useDeferredMount } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'

import ChatActionButtons from '../Widgets/ChatActionButtons.vue'
import ChatArea from '../Widgets/ChatArea.vue'
import ChatContainer from '../Widgets/ChatContainer.vue'

import { useChatToolCallRerun } from '../../composables/useChatToolCallRerun'

const { isReady } = useDeferredMount()
const { sending } = storeToRefs(useChatOrchestratorStore())
const chatSession = useChatSessionStore()
const { messages } = storeToRefs(chatSession)
const { streamingMessage } = storeToRefs(useChatStreamStore())

const isLoading = ref(true)
const sessionsDrawerOpen = ref(false)
const historyMessages = computed(() => messages.value as unknown as ChatHistoryItem[])
const { trackChatMessageDeleted } = useAnalytics()
const { rerunToolCall } = useChatToolCallRerun()

function handleDeleteMessage(index: number) {
  const message = messages.value[index]
  messages.value = messages.value.filter((_, messageIndex) => messageIndex !== index)
  trackChatMessageDeleted({
    source: 'history',
    message_role: message?.role ?? 'unknown',
  })
}

async function handleBranchMessage(index: number) {
  await chatSession.forkSession({
    fromSessionId: chatSession.activeSessionId,
    atIndex: index + 1,
    setActive: true,
  })
}
</script>

<template>
  <div flex="col" items-center pt-4>
    <div h-full max-h="[85vh]" w-full py="4" flex flex-row overflow-hidden>
      <ChatSessionsDrawer v-model="sessionsDrawerOpen" />
      <ChatContainer class="min-w-0 flex-1">
        <div
          v-if="isLoading"
          absolute left-0 top-0 h-1 w-full overflow-hidden rounded-t-xl
          class="bg-primary-500/20"
        >
          <div h-full w="1/3" origin-left bg-primary-500 class="animate-scan" />
        </div>
        <div w="full" max-h="<md:[60%]" py="<sm:2" flex="~ col" rounded="lg" relative h-full flex-1 overflow-hidden px="2 <md:0" py-4>
          <ChatHistory
            v-if="isReady"
            :messages="historyMessages"
            :sending="sending"
            :streaming-message="streamingMessage"
            h-full
            variant="desktop"
            @delete-message="handleDeleteMessage($event.index)"
            @branch-message="handleBranchMessage($event.index)"
            @tool-call-rerun="rerunToolCall"
            @vue:mounted="isLoading = false"
          />
        </div>
        <ChatArea />
      </ChatContainer>
    </div>

    <ChatActionButtons v-model:sessions-open="sessionsDrawerOpen" />
  </div>
</template>

<style scoped>
@keyframes scan {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(400%);
  }
}

.animate-scan {
  animation: scan 2s infinite linear;
}
</style>
