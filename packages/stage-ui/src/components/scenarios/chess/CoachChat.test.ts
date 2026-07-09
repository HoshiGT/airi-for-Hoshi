// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import CoachChat from './CoachChat.vue'

// The mic toggle is the only type="button" control; the send control is type="submit".
function micButton(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('button[type="button"]')
}

describe('coachChat voice controls', () => {
  it('clicking the mic toggle emits toggleVoice', async () => {
    const wrapper = mount(CoachChat, { props: { messages: [], sending: false } })
    await micButton(wrapper).trigger('click')
    expect(wrapper.emitted('toggleVoice')).toBeTruthy()
  })

  it('shows the idle hint when voice mode is off', () => {
    const wrapper = mount(CoachChat, { props: { messages: [], sending: false } })
    expect(wrapper.text()).toContain('下棋途中随时问')
  })

  it('shows the listening status while voice mode is on and listening', () => {
    const wrapper = mount(CoachChat, { props: { messages: [], sending: false, voiceEnabled: true, voicePhase: 'listening' } })
    expect(wrapper.text()).toContain('在听')
  })

  it('shows the speaking status while Airi is talking', () => {
    const wrapper = mount(CoachChat, { props: { messages: [], sending: false, voiceEnabled: true, voicePhase: 'speaking' } })
    expect(wrapper.text()).toContain('Airi 在说')
  })

  it('renders a voice error/hint when provided', () => {
    const hint = '先去设置选语音识别 provider'
    const wrapper = mount(CoachChat, { props: { messages: [], sending: false, voiceError: hint } })
    expect(wrapper.text()).toContain(hint)
  })

  it('submitting typed text still emits ask with the trimmed text', async () => {
    const wrapper = mount(CoachChat, { props: { messages: [], sending: false } })
    await wrapper.find('input').setValue('这步怎么走')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('ask')?.[0]).toEqual(['这步怎么走'])
  })
})
