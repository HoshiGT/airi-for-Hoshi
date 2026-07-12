<script setup lang="ts">
import { Button, FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { useTimeoutFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useQQStore } from '../../stores/modules/messaging-qq'

const { t } = useI18n()
const qqStore = useQQStore()
const { enabled, botUin, napCatToken, configured } = storeToRefs(qqStore)

const restartRequested = ref(false)
const { start: scheduleRestartHintDismiss } = useTimeoutFn(() => {
  restartRequested.value = false
}, 5000, { immediate: false })

function saveSettings() {
  qqStore.saveSettings()
}

function restartWsServer() {
  qqStore.restartWsServer()
  // 指令是单向的（qq-bot 不回执），只提示「已发送」而不是「已重启」
  restartRequested.value = true
  scheduleRestartHintDismiss()
}
</script>

<template>
  <div flex="~ col gap-6">
    <FieldCheckbox
      v-model="enabled"
      :label="t('settings.pages.modules.messaging-qq.enable')"
      :description="t('settings.pages.modules.messaging-qq.enable-description')"
    />

    <FieldInput
      v-model="botUin"
      :label="t('settings.pages.modules.messaging-qq.bot-uin')"
      :description="t('settings.pages.modules.messaging-qq.bot-uin-description')"
      :placeholder="t('settings.pages.modules.messaging-qq.bot-uin-placeholder')"
    />

    <FieldInput
      v-model="napCatToken"
      type="password"
      :label="t('settings.pages.modules.messaging-qq.napcat-token')"
      :description="t('settings.pages.modules.messaging-qq.napcat-token-description')"
      :placeholder="t('settings.pages.modules.messaging-qq.napcat-token-placeholder')"
    />

    <div>
      <Button
        :label="t('settings.common.save')"
        variant="primary"
        @click="saveSettings"
      />
    </div>

    <div v-if="configured" class="mt-4 rounded-lg bg-green-100 p-4 text-green-800">
      {{ t('settings.pages.modules.messaging-qq.configured') }}
    </div>

    <div :class="['flex flex-col gap-2', 'border-t border-neutral-200 dark:border-neutral-800', 'pt-4']">
      <div :class="['text-sm', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.messaging-qq.restart-ws-description') }}
      </div>
      <div>
        <Button
          :label="t('settings.pages.modules.messaging-qq.restart-ws')"
          variant="secondary"
          @click="restartWsServer"
        />
      </div>
      <div v-if="restartRequested" :class="['rounded-lg p-3 text-sm', 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200']">
        {{ t('settings.pages.modules.messaging-qq.restart-ws-sent') }}
      </div>
    </div>
  </div>
</template>
