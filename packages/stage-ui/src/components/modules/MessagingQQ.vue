<script setup lang="ts">
import { Button, FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

import { useQQStore } from '../../stores/modules/messaging-qq'

const { t } = useI18n()
const qqStore = useQQStore()
const { enabled, botUin, napCatToken, configured } = storeToRefs(qqStore)

function saveSettings() {
  qqStore.saveSettings()
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
  </div>
</template>
