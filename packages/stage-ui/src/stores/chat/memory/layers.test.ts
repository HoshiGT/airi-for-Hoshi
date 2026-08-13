import { describe, expect, it } from 'vitest'

import { initialLayerState, L1_MAX_WARMUP, L2_BATCH, L3_BATCH, nextWarmupStep, planLayerPass, stateAfterL1Pass, WARMUP_STEPS } from './layers'

const noPending = { l1Pending: 0, l2Pending: 0 }

function schedule(partial: Partial<{ warmupStep: number, l1RoundsProcessed: number, l1PassCount: number }> = {}) {
  return { ...initialLayerState(), ...partial }
}

describe('nextWarmupStep', () => {
  it('walks the 1 → 2 → 4 → 8 progression and caps at 8', () => {
    expect([...WARMUP_STEPS.slice(1), L1_MAX_WARMUP]).toEqual([2, 4, 8, 8])

    let step: number = WARMUP_STEPS[0]
    for (const expected of [2, 4, 8, 8]) {
      step = nextWarmupStep(step)
      expect(step).toBe(expected)
    }
  })
})

describe('stateAfterL1Pass', () => {
  it('advances the warm-up and watermark after a successful pass', () => {
    const next = stateAfterL1Pass(schedule(), 3)

    expect(next.warmupStep).toBe(2)
    expect(next.l1RoundsProcessed).toBe(3)
    expect(next.l1PassCount).toBe(1)
  })
})

describe('planLayerPass', () => {
  it('runs no pass when nothing reached its threshold', () => {
    expect(planLayerPass({ ...schedule({ warmupStep: 4 }), roundCount: 3, counts: noPending })).toEqual({ type: 'none' })
  })

  it('distills new rounds once the warm-up interval is met', () => {
    expect(planLayerPass({ ...schedule({ warmupStep: 2, l1RoundsProcessed: 1 }), roundCount: 3, counts: noPending }))
      .toEqual({ type: 'l1', roundFrom: 2, roundTo: 3 })
  })

  it('distills from the watermark even when more rounds piled up', () => {
    expect(planLayerPass({ ...schedule({ warmupStep: 2, l1RoundsProcessed: 0 }), roundCount: 7, counts: noPending }))
      .toEqual({ type: 'l1', roundFrom: 1, roundTo: 7 })
  })

  it('prioritizes L1 over a due L2 batch so round processing never stalls', () => {
    const action = planLayerPass({
      ...schedule({ warmupStep: 2, l1RoundsProcessed: 0 }),
      roundCount: 4,
      counts: { l1Pending: L2_BATCH, l2Pending: 0 },
    })
    expect(action).toEqual({ type: 'l1', roundFrom: 1, roundTo: 4 })
  })

  it('triggers L2 once enough L1 facts await aggregation', () => {
    expect(planLayerPass({ ...schedule({ warmupStep: 8, l1RoundsProcessed: 8 }), roundCount: 9, counts: { l1Pending: L2_BATCH, l2Pending: 0 } }))
      .toEqual({ type: 'l2' })
  })

  it('triggers L3 before L2 once enough scenes await the profile', () => {
    const action = planLayerPass({
      ...schedule({ warmupStep: 8, l1RoundsProcessed: 8 }),
      roundCount: 9,
      counts: { l1Pending: L2_BATCH, l2Pending: L3_BATCH },
    })
    expect(action).toEqual({ type: 'l3' })
  })

  it('re-anchors the watermark when history was trimmed past it', () => {
    // ROOT CAUSE:
    //
    // Round numbering is positional; after the daily pass trims old rounds,
    // every remaining round shifts down. A stale watermark larger than the
    // live count would block distillation forever (newRounds < 0) or, with
    // naive clamping, re-distill already-processed rounds. Re-anchoring to
    // the current count resumes the schedule from the surviving tail — the
    // trimmed rounds were already archived by the daily pass.
    expect(planLayerPass({
      ...schedule({ warmupStep: 2, l1RoundsProcessed: 30 }),
      roundCount: 5,
      counts: noPending,
    })).toEqual({ type: 'none' })
  })

  it('resumes the cadence after the caller persists the re-anchored watermark', () => {
    const action = planLayerPass({
      ...schedule({ warmupStep: 2, l1RoundsProcessed: 5 }),
      roundCount: 8,
      counts: noPending,
    })
    expect(action).toEqual({ type: 'l1', roundFrom: 6, roundTo: 8 })
  })
})
