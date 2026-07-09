import { describe, expect, it } from 'vitest'

import { buildKeyboardArgs, buildMouseArgs } from './desktop-control-input'

describe('buildMouseArgs', () => {
  it('moves the pointer to rounded absolute coordinates', () => {
    expect(buildMouseArgs({ action: 'move', x: 960.6, y: 540.2 })).toEqual(['mousemove', '961', '540'])
  })

  it('rejects a move without coordinates', () => {
    expect(() => buildMouseArgs({ action: 'move' })).toThrowError(/requires numeric x and y/)
  })

  it('chains move then left click by default', () => {
    expect(buildMouseArgs({ action: 'click', x: 10, y: 20 })).toEqual(['mousemove', '10', '20', 'click', '1'])
  })

  it('maps named buttons to X11 button codes', () => {
    expect(buildMouseArgs({ action: 'click', x: 0, y: 0, button: 'right' })).toEqual(['mousemove', '0', '0', 'click', '3'])
    expect(buildMouseArgs({ action: 'click', x: 0, y: 0, button: 'middle' })).toEqual(['mousemove', '0', '0', 'click', '2'])
  })

  it('clicks at the current pointer when no coordinates are given', () => {
    expect(buildMouseArgs({ action: 'click' })).toEqual(['click', '1'])
  })

  it('double clicks with a repeat and delay', () => {
    expect(buildMouseArgs({ action: 'double_click', x: 5, y: 6 })).toEqual(['mousemove', '5', '6', 'click', '--repeat', '2', '--delay', '120', '1'])
  })

  it('scrolls down with wheel button 5 for a positive amount', () => {
    expect(buildMouseArgs({ action: 'scroll', scrollAmount: 3 })).toEqual(['click', '--repeat', '3', '5'])
  })

  it('scrolls up with wheel button 4 for a negative amount', () => {
    expect(buildMouseArgs({ action: 'scroll', scrollAmount: -2 })).toEqual(['click', '--repeat', '2', '4'])
  })

  it('defaults scroll to 3 notches down when amount is omitted', () => {
    expect(buildMouseArgs({ action: 'scroll' })).toEqual(['click', '--repeat', '3', '5'])
  })

  it('clamps a runaway scroll amount', () => {
    expect(buildMouseArgs({ action: 'scroll', scrollAmount: 9999 })).toEqual(['click', '--repeat', '50', '5'])
  })
})

describe('buildKeyboardArgs', () => {
  it('types literal text after an option terminator', () => {
    expect(buildKeyboardArgs({ action: 'type', text: 'hello world' })).toEqual(['type', '--clearmodifiers', '--', 'hello world'])
  })

  it('rejects typing empty text', () => {
    expect(() => buildKeyboardArgs({ action: 'type', text: '' })).toThrowError(/non-empty text/)
  })

  it('passes leading-dash text as data, not a flag', () => {
    expect(buildKeyboardArgs({ action: 'type', text: '--force' })).toEqual(['type', '--clearmodifiers', '--', '--force'])
  })

  it('splits a chord list into separate key tokens', () => {
    expect(buildKeyboardArgs({ action: 'key', keys: 'ctrl+c ctrl+v' })).toEqual(['key', '--clearmodifiers', '--', 'ctrl+c', 'ctrl+v'])
  })

  it('sends a single chord', () => {
    expect(buildKeyboardArgs({ action: 'key', keys: 'Return' })).toEqual(['key', '--clearmodifiers', '--', 'Return'])
  })

  it('rejects an empty chord', () => {
    expect(() => buildKeyboardArgs({ action: 'key', keys: '   ' })).toThrowError(/non-empty chord/)
  })
})
