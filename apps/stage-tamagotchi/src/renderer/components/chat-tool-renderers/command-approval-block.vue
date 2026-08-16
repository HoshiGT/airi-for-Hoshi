<script setup lang="ts">
/**
 * Inline approval card for a shell command the character wants to run.
 *
 * `computer-use-mcp` does not execute a risky action directly: it parks it as a
 * pending action and hands back an "approval required" result. The approve tool
 * that would release it is withheld from the model (see `isHumanOnlyMcpTool` in
 * stage-ui), so this card is the only thing that can move it forward — which is
 * the point. The literal command is rendered from the *server's* record of what
 * was parked, and nothing runs until the user clicks.
 *
 * Every MCP call reaches chat as the same `builtIn_mcpCallTool` tool-call, so
 * this renderer is registered for that name and falls back to the generic block
 * whenever the turn is not a parked command.
 */

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { ChatToolCallBlock } from '@proj-airi/stage-ui/components/scenarios/chat'
import {
  approveToolNameFor,
  describeMcpResultText,
  parsePendingCommandApproval,
  rejectToolNameFor,
} from '@proj-airi/stage-ui/tools/mcp-pending-approval'
import { Button, ContainerError } from '@proj-airi/ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { electronMcpCallTool } from '../../../shared/eventa'
import { useChatSyncStore } from '../../stores/chat-sync'

const props = defineProps<{
  toolCallId: string
  toolName: string
  args: string
  state?: 'executing' | 'done' | 'error'
  result?: unknown
}>()

const emit = defineEmits<{
  (e: 'toolCallRerun', payload: { toolCallId: string, toolName: string, args: string }): void
}>()

const callMcpTool = useElectronEventaInvoke(electronMcpCallTool)
const chatSyncStore = useChatSyncStore()
const { t } = useI18n()

/** Null for any turn that is not a command waiting on the user. */
const approval = computed(() => parsePendingCommandApproval(props.args, props.result))

/**
 * Which way this card has been resolved. Local rather than derived: the pending
 * action lives in the MCP server's session and the tool result in history is
 * frozen at "approval_required", so after a click nothing upstream changes.
 */
const decision = ref<'pending' | 'running' | 'approved' | 'rejected'>('pending')
const outcome = ref('')
const failure = ref('')

async function resolve(approved: boolean) {
  const pending = approval.value
  if (!pending || decision.value !== 'pending')
    return

  decision.value = 'running'
  failure.value = ''

  try {
    const result = await callMcpTool({
      name: approved ? approveToolNameFor(pending) : rejectToolNameFor(pending),
      arguments: { id: pending.pendingActionId },
    })

    outcome.value = describeMcpResultText(result)
    decision.value = approved ? 'approved' : 'rejected'

    // The decision happened outside the model's turn, so it has to be told what
    // came of the command it asked for — otherwise it is left waiting on a tool
    // result that will never arrive.
    //
    // Deliberately not translated: this goes to the model, not to the user, and
    // the surrounding toolset prompts are English too. The character replies in
    // whatever language the conversation is in regardless.
    await chatSyncStore.requestIngest({
      text: approved
        ? `[system] The user approved \`${pending.command}\`. Result:\n${outcome.value}`
        : `[system] The user declined to run \`${pending.command}\`. Do not try to run it again unless they ask; continue without it.`,
      toolset: 'artistry',
    })
  }
  catch (error) {
    // Back to pending: the click never reached the server, so the action is
    // still parked and the user should be able to try again.
    decision.value = 'pending'
    failure.value = errorMessageFrom(error) ?? t('stage.chat.command-approval.unreachable')
  }
}

function emitToolCallRerun(payload: { toolCallId: string, toolName: string, args: string }) {
  emit('toolCallRerun', payload)
}

const statusLabel = computed(() => {
  switch (decision.value) {
    case 'approved':
      return t('stage.chat.command-approval.status.approved')
    case 'rejected':
      return t('stage.chat.command-approval.status.declined')
    case 'running':
      return t('stage.chat.command-approval.status.running')
    default:
      return t('stage.chat.command-approval.status.pending')
  }
})
</script>

<template>
  <ChatToolCallBlock
    v-if="!approval"
    :tool-call-id="props.toolCallId"
    :tool-name="props.toolName"
    :args="props.args"
    :state="props.state"
    :result="props.result"
    @tool-call-rerun="emitToolCallRerun"
  />

  <div
    v-else
    :class="[
      'rounded-lg px-3 py-3',
      'flex flex-col gap-3 items-stretch',
      'border border-amber-400/60 dark:border-amber-300/40',
      'bg-amber-50/80 dark:bg-amber-950/40',
    ]"
  >
    <div :class="['flex items-center gap-2']">
      <div class="i-solar:command-outline text-amber-600 dark:text-amber-300" />
      <span :class="['text-sm font-medium']" text="amber-800 dark:amber-200">
        {{ t('stage.chat.command-approval.title') }}
      </span>
      <span
        v-if="approval.riskLevel"
        :class="['ml-auto text-xs rounded px-1.5 py-0.5 uppercase tracking-wide']"
        bg="amber-200/70 dark:amber-800/50" text="amber-900 dark:amber-100"
      >
        {{ approval.riskLevel }}
      </span>
    </div>

    <pre
      :class="['text-sm font-mono whitespace-pre-wrap break-all', 'rounded px-2 py-2']"
      bg="black/5 dark:white/10" text="black/85 dark:white/85"
    >{{ approval.command }}</pre>

    <div v-if="approval.cwd" :class="['text-xs font-mono']" text="black/50 dark:white/50">
      {{ t('stage.chat.command-approval.cwd', { path: approval.cwd }) }}
    </div>

    <div v-if="approval.reason" :class="['text-xs']" text="black/55 dark:white/55">
      {{ approval.reason }}
    </div>

    <ContainerError v-if="failure" :class="['text-xs']">
      {{ failure }}
    </ContainerError>

    <div :class="['flex items-center gap-2']">
      <template v-if="decision === 'pending' || decision === 'running'">
        <Button
          variant="secondary"
          size="sm"
          :label="t('stage.chat.command-approval.decline')"
          :disabled="decision === 'running'"
          @click="resolve(false)"
        />
        <Button
          variant="caution"
          size="sm"
          :label="t('stage.chat.command-approval.run')"
          :disabled="decision === 'running'"
          :loading="decision === 'running'"
          @click="resolve(true)"
        />
      </template>
      <span :class="['text-xs']" text="black/50 dark:white/50">{{ statusLabel }}</span>
    </div>

    <pre
      v-if="outcome && decision === 'approved'"
      :class="['text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto', 'rounded px-2 py-2']"
      bg="black/5 dark:white/10" text="black/75 dark:white/75"
    >{{ outcome }}</pre>
  </div>
</template>
