<script setup lang="ts">
import { ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  defaultHeight?: string
  submitOnEnter?: boolean
}>(), {
  submitOnEnter: true,
})

const events = defineEmits<{
  (event: 'submit', message: string): void
  (event: 'pasteFile', files: File[]): void
}>()

const input = defineModel<string>({
  default: '',
})

const textareaRef = ref<HTMLTextAreaElement>()
const textareaHeight = ref('auto')

// NOTICE:
// When the browser can size the field to its content natively (`field-sizing:
// content`, Chromium 123+), we let CSS do the auto-grow. The old JS path below
// writes `height: auto` and then reads `scrollHeight` on every keystroke, which
// forces a synchronous full-document layout flush; in a long chat the whole
// message list gets re-laid-out per keystroke and typing feels laggy.
// Source: https://developer.mozilla.org/en-US/docs/Web/CSS/field-sizing
// Removal condition: once every target runtime supports field-sizing (Firefox
// still lacks it as of 2026-07), delete the JS fallback watcher entirely.
const supportsFieldSizing = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

function onKeyDown(e: KeyboardEvent) {
  if (!props.submitOnEnter)
    return

  if (e.code === 'Enter' && !e.shiftKey) { // just block Enter is enough, Shift+Enter by default generates a newline
    e.preventDefault()
    events('submit', input.value)
  }
}

function onPaste(e: ClipboardEvent) {
  if (!e.clipboardData)
    return

  const { files } = e.clipboardData
  if (files.length > 0) {
    e.preventDefault()
    events('pasteFile', Array.from(files))
  }
}

// javascript - Creating a textarea with auto-resize - Stack Overflow
// https://stackoverflow.com/questions/454202/creating-a-textarea-with-auto-resize
// Fallback path only: runs where `field-sizing: content` is unsupported.
if (!supportsFieldSizing) {
  watch(input, () => {
    textareaHeight.value = 'auto'
    requestAnimationFrame(() => {
      if (!textareaRef.value)
        return
      if (input.value === '') {
        textareaHeight.value = props.defaultHeight || 'fit-content'
        return
      }

      // NOTICE: not sure why 4px is required but if not added, when
      // input happened and placeholder now disappeared, the textarea will shrink
      // a little bit and cause the input box to shake.
      // TODO: find out the root cause and remove this magic number, or at least
      // reference a more specific source.
      textareaHeight.value = `${textareaRef.value.scrollHeight + 4}px`
    })
  }, { immediate: true })
}
</script>

<template>
  <textarea
    ref="textareaRef"
    v-model="input"
    :style="supportsFieldSizing ? 'field-sizing: content' : { height: textareaHeight }"
    @keydown="onKeyDown"
    @paste="onPaste"
  />
</template>
