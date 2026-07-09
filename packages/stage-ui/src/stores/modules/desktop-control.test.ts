import { describe, expect, it } from 'vitest'

import { mapImagePointToScreen } from './desktop-control'

const fullHdGeometry = {
  width: 1280,
  height: 800,
  displayBounds: { x: 0, y: 0, width: 2560, height: 1600 },
  capturedAt: 0,
}

describe('mapImagePointToScreen', () => {
  it('scales a frame point up to the display resolution', () => {
    expect(mapImagePointToScreen({ x: 640, y: 400 }, fullHdGeometry)).toEqual({ x: 1280, y: 800 })
  })

  it('keeps the origin at the origin', () => {
    expect(mapImagePointToScreen({ x: 0, y: 0 }, fullHdGeometry)).toEqual({ x: 0, y: 0 })
  })

  it('offsets by the display bounds for a secondary monitor', () => {
    const geometry = {
      width: 1000,
      height: 500,
      displayBounds: { x: 2560, y: 0, width: 2000, height: 1000 },
      capturedAt: 0,
    }
    expect(mapImagePointToScreen({ x: 500, y: 250 }, geometry)).toEqual({ x: 3560, y: 500 })
  })

  it('clamps a point past the frame edge back onto the display', () => {
    expect(mapImagePointToScreen({ x: 5000, y: -20 }, fullHdGeometry)).toEqual({ x: 2560, y: 0 })
  })

  it('falls back to a 1:1 map when the frame has zero width', () => {
    const geometry = {
      width: 0,
      height: 0,
      displayBounds: { x: 0, y: 0, width: 2560, height: 1600 },
      capturedAt: 0,
    }
    expect(mapImagePointToScreen({ x: 0, y: 0 }, geometry)).toEqual({ x: 0, y: 0 })
  })
})
