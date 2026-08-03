import { describe, expect, it } from 'vitest'

import { createChatActionMenuItems, createChatActionMenuTriggerState } from './menu-items'

/**
 * @example
 * describe('createChatActionMenuItems', () => {
 *   it('includes retry between copy and delete when retry is available', () => {})
 * })
 */
describe('createChatActionMenuItems', () => {
  /**
   * @example
   * it('includes retry between copy and delete when retry is available', () => {
   *   const items = createChatActionMenuItems({ canCopy: true, canRetry: true, canDelete: true })
   *   expect(items.map(item => item.action)).toEqual(['copy', 'retry', 'delete'])
   * })
   */
  it('includes retry between copy and delete when retry is available', () => {
    const items = createChatActionMenuItems({
      canCopy: true,
      canRetry: true,
      canBranch: false,
      canDelete: true,
    })

    expect(items.map(item => item.action)).toEqual(['copy', 'retry', 'delete'])
    expect(items[1]?.label).toBe('Retry')
  })

  it('omits retry when retry is unavailable', () => {
    const items = createChatActionMenuItems({
      canCopy: true,
      canRetry: false,
      canBranch: false,
      canDelete: true,
    })

    expect(items.map(item => item.action)).toEqual(['copy', 'delete'])
  })

  it('includes branch between retry and delete when branch is available', () => {
    const items = createChatActionMenuItems({
      canCopy: true,
      canRetry: false,
      canBranch: true,
      canDelete: true,
    })

    expect(items.map(item => item.action)).toEqual(['copy', 'branch', 'delete'])
    expect(items[1]?.label).toBe('Branch')
  })
})

/**
 * @example
 * describe('createChatActionMenuTriggerState', () => {
 *   it('uses a success checkmark while copy feedback is active', () => {})
 * })
 */
describe('createChatActionMenuTriggerState', () => {
  /**
   * @example
   * it('uses a success checkmark while copy feedback is active', () => {
   *   const state = createChatActionMenuTriggerState({ copyFeedbackActive: true })
   *   expect(state.tone).toBe('success')
   * })
   */
  it('uses a success checkmark while copy feedback is active', () => {
    const state = createChatActionMenuTriggerState({ copyFeedbackActive: true })

    expect(state.icon).toBe('i-carbon:checkmark')
    expect(state.tone).toBe('success')
  })

  /**
   * @example
   * it('uses the default menu icon without copy feedback', () => {
   *   const state = createChatActionMenuTriggerState({})
   *   expect(state.tone).toBe('default')
   * })
   */
  it('uses the default menu icon without copy feedback', () => {
    const state = createChatActionMenuTriggerState({})

    expect(state.icon).toBe('i-solar:menu-dots-bold')
    expect(state.tone).toBe('default')
  })
})
