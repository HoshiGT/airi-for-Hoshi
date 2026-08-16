<script setup lang="ts">
import type { MaybeComputedElementRef } from '@vueuse/core'
import type { ComponentPublicInstance } from 'vue'

import type { ChatActionMenuAction } from '.'

import { errorMessageFromValue, isStageCapacitor, isStageWeb } from '@proj-airi/stage-shared'
import { useElementVisibility, useIntervalFn } from '@vueuse/core'
import { createTimeline } from 'animejs'
import { clamp } from 'es-toolkit'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuRoot,
  ContextMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui'
import { computed, inject, reactive, ref, shallowRef, toRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useWebHaptics } from 'web-haptics/vue'

import { createChatActionMenuItems, createChatActionMenuTriggerState } from '.'
import { useBreakpoints } from '../../../../../composables/use-breakpoints'
import { useElementScroll } from '../../composables/use-element-scroll'
import { chatScrollContainerKey } from '../../constants'

const props = withDefaults(defineProps<{
  canCopy?: boolean
  canRetry?: boolean
  canBranch?: boolean
  canDelete?: boolean
  copyText?: string
  menuLabel?: string
  placement?: 'left' | 'right'
}>(), {
  canCopy: true,
  canRetry: false,
  canBranch: true,
  canDelete: true,
  copyText: '',
  menuLabel: 'Message actions',
  placement: 'right',
})

const emit = defineEmits<{
  (e: 'copy'): void
  (e: 'retry'): void
  (e: 'branch'): void
  (e: 'delete'): void
}>()
defineSlots<{
  default: (props: { setMeasuredElement: (element: Element | ComponentPublicInstance | null) => void }) => unknown
}>()

const measuredElement = shallowRef<HTMLElement | null>(null)
const contextMenuContainerElementRef = useTemplateRef<HTMLElement>('contextMenuContainer')
const topSentinelRef = useTemplateRef<HTMLDivElement>('topSentinel')
const bottomSentinelRef = useTemplateRef<HTMLDivElement>('bottomSentinel')
const injectedScrollContainer = inject(chatScrollContainerKey, undefined)
const contextMenuOpen = shallowRef(false)
const dropdownMenuOpen = shallowRef(false)

// NOTICE:
// Every message in the history mounts one of these menus, so anything wired up
// at setup time is paid per message — a 500-message conversation was binding
// ~1500 observers and listeners, and re-binding all of them on every session
// switch. All of it exists purely to place the hover trigger, which cannot be
// seen until the pointer (or a long press, or focus) reaches the message.
//
// Everything below therefore hangs off `interactive`: the refs handed to the
// VueUse composables stay null until first contact, so no ResizeObserver,
// IntersectionObserver, or scroll listener is created for a message the user has
// not touched. The composables themselves must still be called unconditionally
// (they own effect scopes), which is why this is gated on the input refs.
const interactive = shallowRef(false)
function activateInteraction() {
  interactive.value = true
}

const measuredElementRef = computed(() => interactive.value ? measuredElement.value : null)
const scrollTarget = computed(() => interactive.value ? (injectedScrollContainer?.value ?? null) : null)
const observedTopSentinel = computed(() => interactive.value ? topSentinelRef.value : null)
const observedBottomSentinel = computed(() => interactive.value ? bottomSentinelRef.value : null)

const {
  innerHeight,
  innerTop,
  elementHeight,
  elementTop,
  hasMeasuredElement,
  isVisible: messageIsVisible,
  scrollTarget: effectiveScrollTarget,
} = useElementScroll(measuredElementRef, scrollTarget)

const topSentinelVisible = useElementVisibility(observedTopSentinel, {
  initialValue: false,
  scrollTarget: effectiveScrollTarget,
})

const bottomSentinelVisible = useElementVisibility(observedBottomSentinel, {
  initialValue: false,
  scrollTarget: effectiveScrollTarget,
})

const { trigger } = useWebHaptics()
const { isMobile } = useBreakpoints()
const { t } = useI18n()
const shouldDisableDropdownMenu = computed(() => (isStageWeb() || isStageCapacitor()) && isMobile.value)
const copyFeedbackActive = shallowRef(false)

const menuItems = computed(() => createChatActionMenuItems({
  canCopy: props.canCopy && props.copyText.trim().length > 0,
  canRetry: props.canRetry,
  canBranch: props.canBranch,
  canDelete: props.canDelete,
  retryLabel: t('stage.chat.actions.retry'),
  branchLabel: t('stage.chat.actions.branch'),
}))
const triggerState = computed(() => createChatActionMenuTriggerState({
  copyFeedbackActive: copyFeedbackActive.value,
}))
const hasMenuItems = computed(() => menuItems.value.length > 0)
const forceVisible = computed(() => contextMenuOpen.value || dropdownMenuOpen.value)

const contentClasses = [
  'z-10000 min-w-36 rounded-xl p-1 shadow-md outline-none',
  'border border-neutral-100/70 bg-white/90 text-neutral-700 backdrop-blur-md',
  'dark:border-neutral-900/80 dark:bg-neutral-900/90 dark:text-neutral-100',
  'data-[side=bottom]:animate-slideUpAndFade data-[side=left]:animate-slideRightAndFade',
  'data-[side=right]:animate-slideLeftAndFade data-[side=top]:animate-slideDownAndFade',
]

const itemClasses = [
  'relative flex cursor-pointer select-none items-center gap-2 rounded-lg px-3 py-2 text-sm leading-none outline-none',
  'data-[disabled]:pointer-events-none data-[highlighted]:bg-primary-50/80 dark:data-[highlighted]:bg-primary-900/40',
  'transition-colors duration-150 ease-in-out',
]

const topIsVisible = computed(() => topSentinelVisible.value)
const bottomIsVisible = computed(() => bottomSentinelVisible.value)
const floatingInMiddle = computed(() => !topIsVisible.value && !bottomIsVisible.value)

const floatingTop = computed(() => {
  if (!hasMeasuredElement.value || !messageIsVisible.value || !floatingInMiddle.value)
    return 0

  const buttonSize = 32
  const relativeInnerMiddle = innerTop.value - elementTop.value + innerHeight.value / 2 - buttonSize / 2
  return clamp(relativeInnerMiddle, 0, Math.max(elementHeight.value - buttonSize, 0))
})

const showFloatingTrigger = computed(() => !topIsVisible.value)

const triggerStyle = computed(() => (
  bottomIsVisible.value
    ? undefined
    : { top: `${floatingTop.value}px` }
))

function handleContextMenuOpenChange(open: boolean) {
  contextMenuOpen.value = open
}

function handleDropdownMenuOpenChange(open: boolean) {
  dropdownMenuOpen.value = open
}

function setMeasuredElement(element: Element | ComponentPublicInstance | null) {
  measuredElement.value = element instanceof HTMLElement ? element : null
}

function useTouching(element: MaybeComputedElementRef) {
  const elementRef = toRef(element)

  const pressStartTime = ref(0)
  const pressNow = ref(0)

  // NOTICE:
  // `immediate` defaults to true in useIntervalFn, so this used to start a 20Hz
  // timer per message at mount and only stop on the first touchend — which never
  // arrives on desktop. A few hundred messages meant thousands of ref writes per
  // second, forever. The ticker exists to grow `pressedFor` during a long press,
  // so it belongs to the press: started in handleTouchStart, stopped on end.
  const { resume, pause } = useIntervalFn(() => pressNow.value = Date.now(), 50, { immediate: false })

  const isTouching = ref(false)
  const pressedFor = computed(() => {
    if (!isTouching.value || pressStartTime.value === 0)
      return 0

    const result = pressNow.value - pressStartTime.value
    if (result < 0)
      return 0

    return result
  })

  function handleTouchStart() {
    isTouching.value = true
    pressStartTime.value = Date.now()
    resume()
  }

  function handleTouchMove() {
    isTouching.value = true
  }

  function handleTouchEnd() {
    isTouching.value = false
    pressStartTime.value = 0
    pause()
  }

  function handleTouchCancel() {
    isTouching.value = false
    pressStartTime.value = 0
    pause()
  }

  watch(elementRef, (newElement) => {
    if (newElement) {
      const el = newElement as HTMLElement

      el.addEventListener('touchstart', handleTouchStart, { passive: true })
      el.addEventListener('touchmove', handleTouchMove, { passive: true })
      el.addEventListener('touchend', handleTouchEnd, { passive: true })
      el.addEventListener('touchcancel', handleTouchCancel, { passive: true })
    }
    else if (elementRef.value) {
      const el = elementRef.value as HTMLElement

      el.removeEventListener('touchstart', handleTouchStart)
      el.removeEventListener('touchmove', handleTouchMove)
      el.removeEventListener('touchend', handleTouchEnd)
      el.removeEventListener('touchcancel', handleTouchCancel)
    }
  }, { immediate: true })

  return {
    isTouching,
    pressedFor,
  }
}

function useSetTimeoutFn(fn: () => void, options?: { delay?: number, onClear?: () => void }) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const delay = options?.delay ?? 1000

  function trigger(options?: { delay?: number }) {
    if (timeoutId !== null)
      return

    const effectiveDelay = options?.delay ?? delay

    timeoutId = setTimeout(() => {
      fn()
      timeoutId = null
    }, effectiveDelay)
  }

  function clear() {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
      options?.onClear?.()
    }
  }

  return {
    trigger,
    clear,
  }
}

const { isTouching } = useTouching(contextMenuContainerElementRef)

const { trigger: triggerCopyFeedbackReset, clear: clearCopyFeedbackReset } = useSetTimeoutFn(() => {
  copyFeedbackActive.value = false
}, { delay: 1000 })

async function handleAction(action: ChatActionMenuAction) {
  if (action === 'copy') {
    if (!props.copyText.trim())
      return

    try {
      await navigator.clipboard.writeText(props.copyText)
      copyFeedbackActive.value = true
      clearCopyFeedbackReset()
      emit('copy')
      triggerCopyFeedbackReset()
    }
    catch (error) {
      console.error('Failed to copy text:', errorMessageFromValue(error))
    }

    return
  }

  if (action === 'retry') {
    emit('retry')
    return
  }

  if (action === 'branch') {
    emit('branch')
    return
  }

  emit('delete')
}

const pressedAnimatable = reactive({ scale: 100 })

// Built on first press instead of at setup: this is the long-press squeeze, so a
// message that is only ever read never needs an animejs timeline (one per
// message across the whole history otherwise).
let pressTimeline: ReturnType<typeof createTimeline> | null = null
function getPressTimeline() {
  pressTimeline ??= createTimeline({ defaults: { duration: 500, autoplay: false } })
    .add(pressedAnimatable, { scale: 90, ease: 'inOut', autoplay: false })
    .reset()

  return pressTimeline
}

const { trigger: triggerTimer, clear: clearTimer } = useSetTimeoutFn(() => {
  trigger('medium')
  pressTimeline?.reset()
}, { delay: 700 })

watch(isTouching, (val) => {
  if (val) {
    const timeline = getPressTimeline()
    if (timeline.completed || timeline.paused) {
      timeline.restart()
    }
    else {
      timeline.play()
    }

    triggerTimer()
  }
  else {
    pressTimeline?.reset()

    clearTimer()
  }
})
</script>

<template>
  <ContextMenuRoot @update:open="handleContextMenuOpenChange">
    <ContextMenuTrigger as-child>
      <div
        ref="contextMenuContainer"
        :class="[
          'group/chat-action relative w-fit',
          'transition-transform duration-150 ease-in-out',
        ]"
        :style="{
          transform: `scale(${pressedAnimatable.scale / 100})`,
        }"
        @pointerenter="activateInteraction"
        @focusin="activateInteraction"
        @contextmenu="activateInteraction"
        @touchstart.passive="activateInteraction"
      >
        <div
          ref="topSentinel"
          aria-hidden="true"
          class="pointer-events-none absolute inset-x-0 top-0 h-px opacity-0"
        />
        <div
          ref="bottomSentinel"
          aria-hidden="true"
          class="pointer-events-none absolute inset-x-0 bottom-0 h-px opacity-0"
        />

        <DropdownMenuRoot @update:open="handleDropdownMenuOpenChange">
          <DropdownMenuTrigger
            v-if="hasMenuItems && !shouldDisableDropdownMenu"
            as-child
            :class="[
              'absolute z-10 opacity-0 transition-opacity duration-200',
              'group-hover/chat-action:opacity-100 group-focus-within/chat-action:opacity-100',
              forceVisible ? 'opacity-100' : '',
              props.placement === 'left' ? 'left-0 translate-x-[calc(-100%-8px)]' : 'right-0 translate-x-[calc(100%+8px)]',
              showFloatingTrigger && bottomIsVisible ? 'bottom-0' : 'top-0',
            ]"
            :style="triggerStyle"
          >
            <button
              :class="[
                'h-8 w-8 flex items-center justify-center rounded-lg',
                'bg-white/85 text-neutral-500 backdrop-blur-sm',
                'dark:bg-neutral-900/85 dark:text-neutral-300',
                'transition-colors hover:text-primary-500 dark:hover:text-primary-300',
              ]"
              :aria-label="menuLabel"
            >
              <div
                :class="[
                  triggerState.icon,
                  'text-base',
                  triggerState.tone === 'success' ? 'text-emerald-600 dark:text-emerald-300' : '',
                ]"
              />
            </button>
          </DropdownMenuTrigger>

          <slot :set-measured-element="setMeasuredElement" />

          <DropdownMenuPortal>
            <DropdownMenuContent
              align="end"
              side="bottom"
              :side-offset="6"
              :class="contentClasses"
            >
              <DropdownMenuItem
                v-for="item in menuItems"
                :key="item.action"
                :class="[
                  ...itemClasses,
                  item.danger
                    ? 'text-red-500 data-[highlighted]:bg-red-50/80 dark:data-[highlighted]:bg-red-950/40'
                    : '',
                ]"
                @select="() => void handleAction(item.action)"
              >
                <div :class="[item.icon, 'text-xs']" />
                <span>{{ item.label }}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </div>
    </ContextMenuTrigger>

    <ContextMenuPortal>
      <ContextMenuContent
        :class="[
          ...contentClasses,
        ]"
      >
        <ContextMenuItem
          v-for="item in menuItems"
          :key="item.action"
          :class="[
            ...itemClasses,
            item.danger
              ? 'text-red-500 data-[highlighted]:bg-red-50/80 dark:data-[highlighted]:bg-red-950/40'
              : '',
          ]"
          @select="() => void handleAction(item.action)"
        >
          <div
            :class="[
              item.icon, 'text-xs',
            ]"
          />
          <span>
            {{ item.label }}
          </span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>
