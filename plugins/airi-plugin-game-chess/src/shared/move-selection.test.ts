import type { EngineCandidate } from './types'

import { describe, expect, it } from 'vitest'

import {
  buildMoveRequest,
  formatEvaluation,
  MOVE_NAMESPACE,
  moveCallName,
  resolveMove,
} from './move-selection'

const candidates: EngineCandidate[] = [
  { uci: 'e2e4', san: 'e4', rank: 1, scoreCp: 34 },
  { uci: 'd2d4', san: 'd4', rank: 2, scoreCp: 18 },
  { uci: 'g1f3', san: 'Nf3', rank: 3, scoreCp: 12 },
]

describe('moveCallName', () => {
  it('encodes chess and xiangqi UCI moves as call names', () => {
    expect(moveCallName('e2e4')).toBe('play_e2e4')
    expect(moveCallName('h2e2')).toBe('play_h2e2')
    expect(moveCallName('e7e8q')).toBe('play_e7e8q')
  })
})

describe('formatEvaluation', () => {
  it('renders centipawn scores as signed pawns', () => {
    expect(formatEvaluation({ scoreCp: 34 })).toBe('+0.3')
    expect(formatEvaluation({ scoreCp: -150 })).toBe('-1.5')
  })

  it('renders mate scores from the mover perspective', () => {
    expect(formatEvaluation({ mate: 2 })).toBe('mate in 2')
    expect(formatEvaluation({ mate: -3 })).toBe('mated in 3')
  })

  it('renders unknown evaluations', () => {
    expect(formatEvaluation({})).toBe('unclear')
  })
})

describe('buildMoveRequest', () => {
  it('registers one named call per candidate and carries board context', () => {
    const envelope = buildMoveRequest({
      variant: 'chess',
      airiSide: 'first',
      fen: 'startpos',
      candidates,
      requestId: 'req-1',
      fallbackResponseText: 'Let me think…',
    })

    expect(envelope.route.namespace).toBe(MOVE_NAMESPACE)
    expect(envelope.payload.requestId).toBe('req-1')
    expect(envelope.payload.responseRoute).toEqual({ namespace: MOVE_NAMESPACE, name: 'response' })
    expect(envelope.payload.timeoutMs).toBe(8000)
    expect(envelope.payload.calls.map(call => call.name)).toEqual(['play_e2e4', 'play_d2d4', 'play_g1f3'])
    expect(envelope.payload.sparkNotify.headline.length).toBeGreaterThan(0)
    expect(envelope.payload.sparkNotify.destinations).toEqual(['character'])
    expect(envelope.payload.sparkNotify.payload.candidates).toHaveLength(3)
  })

  it('labels the xiangqi side in the headline', () => {
    const envelope = buildMoveRequest({
      variant: 'xiangqi',
      airiSide: 'first',
      fen: 'startpos',
      candidates: [{ uci: 'h2e2', san: 'C2=5', rank: 1, scoreCp: 20 }],
      requestId: 'req-2',
      fallbackResponseText: '让我想想…',
    })

    expect(envelope.payload.calls[0].name).toBe('play_h2e2')
    expect(envelope.payload.sparkNotify.headline).toContain('Chinese chess')
  })
})

describe('resolveMove', () => {
  it('plays the move Airi called and keeps the reaction as commentary', () => {
    const decision = resolveMove(
      { performance: { type: 'called', name: 'play_d2d4' }, text: 'I like a closed game.' },
      candidates,
      'fallback',
    )
    expect(decision).toEqual({ uci: 'd2d4', commentary: 'I like a closed game.', source: 'airi' })
  })

  it('falls back to the engine best when Airi does not call a move', () => {
    const decision = resolveMove({ performance: { type: 'completed' }, text: 'Hmm.' }, candidates, 'fallback')
    expect(decision).toEqual({ uci: 'e2e4', commentary: 'Hmm.', source: 'fallback' })
  })

  it('falls back when the called name matches no candidate', () => {
    const decision = resolveMove({ performance: { type: 'called', name: 'play_a1a8' } }, candidates, 'fallback')
    expect(decision.uci).toBe('e2e4')
    expect(decision.source).toBe('fallback')
  })

  it('uses the fallback text when the reaction is empty', () => {
    const decision = resolveMove({ performance: { type: 'timeout' }, text: '   ' }, candidates, 'thinking…')
    expect(decision).toEqual({ uci: 'e2e4', commentary: 'thinking…', source: 'fallback' })
  })
})
