import type { ChatHistoryItem } from '../../../../types/chat'

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { computed, defineComponent, shallowRef } from 'vue'
import { createI18n } from 'vue-i18n'

import ChatHistory from './history.vue'

import { getChatHistoryItemKey } from '../utils'

vi.mock('../composables/use-chat-history-scroll', () => ({
  useChatHistoryScroll: () => undefined,
}))

vi.mock('../../../markdown', () => ({
  MarkdownRenderer: defineComponent({
    name: 'MarkdownRendererStub',
    props: {
      content: {
        type: String,
        default: '',
      },
    },
    template: '<div>{{ content }}</div>',
  }),
}))

// NOTICE:
// `virtual:uno.css` is generated from whatever UnoCSS has scanned at the moment
// it is requested. A static import here resolves before `history.vue` is
// transformed, so utilities used only by that component would be missing and
// every layout assertion below would pass against unstyled markup. Importing it
// lazily, after the component module is loaded, makes the stylesheet complete.
//
// Removal condition: UnoCSS's Vite plugin gaining a deterministic
// "scan everything up front" mode for test runs.
beforeAll(async () => {
  await import('virtual:uno.css')
})

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        stage: {
          chat: {
            actions: {
              retry: 'Retry',
            },
            message: {
              'character-name': {
                'airi': 'AIRI',
                'core-system': 'System',
                'you': 'You',
              },
            },
          },
        },
      },
    },
  })
}

function createHarness(messages: ChatHistoryItem[]) {
  return defineComponent({
    name: 'ChatHistoryRetryHarness',
    components: {
      ChatHistory,
    },
    setup() {
      const lastRetryIndex = shallowRef('none')
      const lastToolCallRerunPayload = shallowRef('')

      function handleRetryMessage(payload: { index: number }) {
        lastRetryIndex.value = String(payload.index)
      }

      function handleToolCallRerun(payload: unknown) {
        lastToolCallRerunPayload.value = JSON.stringify(payload)
      }

      const toolCallRerunPayload = computed(() => lastToolCallRerunPayload.value)

      return {
        handleRetryMessage,
        handleToolCallRerun,
        lastRetryIndex,
        messages,
        toolCallRerunPayload,
      }
    },
    template: `
      <div>
        <ChatHistory
          :messages="messages"
          @retry-message="handleRetryMessage"
          @tool-call-rerun="handleToolCallRerun"
        />
        <output aria-label="retry-index">{{ lastRetryIndex }}</output>
        <output aria-label="tool-call-rerun">{{ toolCallRerunPayload }}</output>
      </div>
    `,
  })
}

/**
 * @example
 * describe('ChatHistory retry actions', () => {
 *   it('emits retry-message when the retry button is clicked for an error after a user message', async () => {})
 * })
 */
describe('chatHistory retry actions', () => {
  /**
   * @example
   * it('emits retry-message when the retry button is clicked for an error after a user message', async () => {
   *   const screen = await render(createHarness(messages), { global: { plugins: [createTestI18n()] } })
   *   await screen.getByRole('button', { name: 'Retry' }).click()
   *   await expect.element(screen.getByLabelText('retry-index')).toHaveTextContent('1')
   * })
   */
  it('emits retry-message when the retry button is clicked for an error after a user message', async () => {
    const messages: ChatHistoryItem[] = [
      { role: 'user', content: 'hello' },
      { role: 'error', content: 'Remote sent 400 response' },
    ]

    const screen = await render(createHarness(messages), {
      global: {
        plugins: [createTestI18n()],
      },
    })

    await screen.getByRole('button', { name: 'Retry' }).click()

    await expect.element(screen.getByLabelText('retry-index')).toHaveTextContent('1')
  })

  /**
   * @example
   * it('does not render the retry button when the error is not preceded by a user message', async () => {
   *   const screen = await render(createHarness(messages), { global: { plugins: [createTestI18n()] } })
   *   expect(document.body.textContent).not.toContain('Retry')
   * })
   */
  it('does not render the retry button when the error is not preceded by a user message', async () => {
    const messages: ChatHistoryItem[] = [
      { role: 'assistant', content: 'hello', slices: [], tool_results: [] },
      { role: 'error', content: 'Remote sent 400 response' },
    ]

    await render(createHarness(messages), {
      global: {
        plugins: [createTestI18n()],
      },
    })

    expect(document.body.textContent).not.toContain('Retry')
  })

  it('emits tool-call-rerun with message context when a tool call rerun button is clicked', async () => {
    const args = JSON.stringify({ location: 'Tokyo' })
    const assistantMessage: ChatHistoryItem = {
      role: 'assistant',
      content: '',
      slices: [
        {
          type: 'tool-call',
          toolCall: {
            toolCallId: 'call-weather',
            toolCallType: 'function',
            toolName: 'weather',
            args,
          },
        },
      ],
      tool_results: [],
      createdAt: 1710000000000,
    }
    const messages: ChatHistoryItem[] = [
      { role: 'user', content: 'weather in Tokyo' },
      assistantMessage,
    ]

    const screen = await render(createHarness(messages), {
      global: {
        plugins: [createTestI18n()],
      },
    })

    await screen.getByLabelText('Re-run tool call').click()

    await expect.element(screen.getByLabelText('tool-call-rerun')).toHaveTextContent(JSON.stringify({
      message: assistantMessage,
      index: 1,
      key: getChatHistoryItemKey(assistantMessage, 1),
      toolCallId: 'call-weather',
      toolName: 'weather',
      args,
    }))
  })
})

/** Must exceed `MIN_MESSAGES_FOR_VIRTUALIZATION` in `history.vue` for the virtual path to engage. */
const VIRTUALIZED_MESSAGE_COUNT = 60

/** Tall enough that several rows are rendered at once, short enough to leave plenty to scroll. */
const VIEWPORT_HEIGHT_PX = 320

function createScrollHarness(messages: ChatHistoryItem[]) {
  return defineComponent({
    name: 'ChatHistoryScrollHarness',
    components: {
      ChatHistory,
    },
    setup() {
      return { messages }
    },
    // The component is `h-full`, so it only scrolls inside a parent with a real height.
    template: `
      <div data-testid="viewport" :style="{ height: '${VIEWPORT_HEIGHT_PX}px' }">
        <ChatHistory :messages="messages" />
      </div>
    `,
  })
}

function createLongHistory(count: number): ChatHistoryItem[] {
  return Array.from({ length: count }, (_, index) => (index % 2 === 0
    ? { role: 'user' as const, content: `question ${index}` }
    : { role: 'assistant' as const, content: `answer ${index}`, slices: [], tool_results: [] }))
}

function scrollContainerOf(): HTMLElement {
  const viewport = document.querySelector<HTMLElement>('[data-testid="viewport"]')
  const container = viewport?.firstElementChild
  if (!(container instanceof HTMLElement))
    throw new TypeError('chat history scroll container not found')

  return container
}

/**
 * Wait for the virtualizer to observe the scroll element and publish a window.
 *
 * `useVirtualizer` only learns the viewport height from a ResizeObserver after
 * mount, so the first paint has no virtual items at all.
 */
async function settleVirtualWindow(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)))
    if (document.querySelectorAll('[data-chat-message-key]').length > 0)
      return
  }
}

function renderedRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-chat-message-key]'))
}

describe('chatHistory virtualized layout', () => {
  // ROOT CAUSE:
  //
  // The virtual window is positioned with `paddingTop`/`paddingBottom` on the
  // inner list while the rows themselves stay in normal flow. That technique is
  // only sound if the rows stack contiguously, because tanstack models row N's
  // offset as the sum of the measured heights of rows 0..N-1.
  //
  // The list was `flex flex-col gap-2`, and `measureElement` reports each row's
  // own border box — the flex gap is not part of any row. So every row sat 8px
  // lower than the model predicted, and the error accumulated with the index:
  //
  //   real offset of row N = model offset + N * gap
  //
  // Sixty rows in, that is ~480px — most of a viewport. `scrollToIndex` then
  // landed the viewport well above the requested message (you saw the tail of
  // the *previous* one), and any streaming-follow scroll snapped back to the
  // stale model offset, which read as the whole list jittering.
  //
  // We fixed this by moving the inter-row spacing inside the measured row
  // wrapper, so a row's measured height already includes the space below it and
  // the flow offsets match the model exactly.
  it('stacks rows contiguously so tanstack row offsets match the real layout', async () => {
    await render(createScrollHarness(createLongHistory(VIRTUALIZED_MESSAGE_COUNT)), {
      global: {
        plugins: [createTestI18n()],
      },
    })
    await settleVirtualWindow()

    const rows = renderedRows()
    // Virtualization must actually be engaged, otherwise this asserts nothing.
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(VIRTUALIZED_MESSAGE_COUNT)

    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1].getBoundingClientRect()
      const current = rows[i].getBoundingClientRect()
      // Sub-pixel rounding is fine; a flex gap would show up as a whole-pixel jump.
      expect(current.top - previous.top).toBeCloseTo(previous.height, 0)
    }
  })

  it('keeps the scrollable height equal to the height the virtual window models', async () => {
    await render(createScrollHarness(createLongHistory(VIRTUALIZED_MESSAGE_COUNT)), {
      global: {
        plugins: [createTestI18n()],
      },
    })
    await settleVirtualWindow()

    const container = scrollContainerOf()
    const list = container.firstElementChild
    if (!(list instanceof HTMLElement))
      throw new TypeError('chat history inner list not found')

    const rows = renderedRows()
    const paddingTop = Number.parseFloat(list.style.paddingTop || '0')
    const paddingBottom = Number.parseFloat(list.style.paddingBottom || '0')
    const renderedHeight = rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0)

    // The container scrolls over exactly padding + rendered window. Any spacing
    // the virtualizer cannot see would inflate scrollHeight beyond this sum.
    expect(container.scrollHeight).toBeCloseTo(paddingTop + renderedHeight + paddingBottom, 0)
  })

  it('still separates adjacent messages visually', async () => {
    await render(createScrollHarness(createLongHistory(VIRTUALIZED_MESSAGE_COUNT)), {
      global: {
        plugins: [createTestI18n()],
      },
    })
    await settleVirtualWindow()

    const rows = renderedRows()
    const firstBubble = rows[0].querySelector('*')
    expect(firstBubble).not.toBeNull()

    // Spacing must live inside the measured row, not between rows — but it must
    // still exist, so the fix cannot be "delete the gap".
    const rowHeight = rows[0].getBoundingClientRect().height
    const bubbleHeight = (firstBubble as HTMLElement).getBoundingClientRect().height
    expect(rowHeight).toBeGreaterThan(bubbleHeight)
  })
})
