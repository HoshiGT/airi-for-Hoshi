// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import MoveList from './MoveList.vue'

describe('moveList notation', () => {
  it('shows an empty hint before any moves', () => {
    const wrapper = mount(MoveList, { props: { history: [] } })
    expect(wrapper.text()).toContain('还没走子')
  })

  // textContent has no spaces — the visual gaps come from CSS margins, not text.
  it('pairs moves by number: first side then second side', () => {
    const wrapper = mount(MoveList, { props: { history: ['e4', 'e5', 'Nf3', 'Nc6'] } })
    const rows = wrapper.findAll('.font-mono > span')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toBe('1.e4e5')
    expect(rows[1].text()).toBe('2.Nf3Nc6')
  })

  it('leaves the second column empty on an odd final move', () => {
    const wrapper = mount(MoveList, { props: { history: ['e4', 'e5', 'Nf3'] } })
    const rows = wrapper.findAll('.font-mono > span')
    expect(rows).toHaveLength(2)
    expect(rows[1].text()).toBe('2.Nf3')
  })

  it('renders no buttons without annotations', () => {
    const wrapper = mount(MoveList, { props: { history: ['e4', 'e5'] } })
    expect(wrapper.findAll('button')).toHaveLength(0)
  })
})

describe('moveList review mode', () => {
  const annotations = [
    { quality: 'best' as const },
    { quality: 'blunder' as const },
    { quality: 'good' as const },
  ]

  it('marks decisive grades with their symbols but leaves fine moves unmarked', () => {
    const wrapper = mount(MoveList, {
      props: { history: ['e4', 'f6', 'Nf3'], annotations, activeIndex: -1 },
    })
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(3)
    expect(buttons[0].text()).toBe('e4★')
    expect(buttons[1].text()).toBe('f6??')
    expect(buttons[2].text()).toBe('Nf3')
  })

  it('emits the ply index when a move is clicked', async () => {
    const wrapper = mount(MoveList, {
      props: { history: ['e4', 'f6', 'Nf3'], annotations, activeIndex: -1 },
    })
    await wrapper.findAll('button')[1].trigger('click')
    expect(wrapper.emitted('select')).toEqual([[1]])
  })

  it('highlights the active ply', () => {
    const wrapper = mount(MoveList, {
      props: { history: ['e4', 'f6', 'Nf3'], annotations, activeIndex: 1 },
    })
    const buttons = wrapper.findAll('button')
    expect(buttons[1].classes()).toContain('bg-sky-600')
    expect(buttons[0].classes()).not.toContain('bg-sky-600')
  })
})
