import type { UciTransport } from './uci'

import { describe, expect, it } from 'vitest'

import { analyzeViaUci, parseBestMove, parseInfoLine } from './uci'

describe('parseInfoLine', () => {
  it('extracts multipv rank, centipawn score, and the candidate move', () => {
    expect(parseInfoLine('info depth 12 multipv 2 score cp -18 nodes 1 pv e7e5 g1f3')).toEqual({
      multipv: 2,
      scoreCp: -18,
      mate: undefined,
      pvFirst: 'e7e5',
    })
  })

  it('defaults multipv to 1 when the field is absent', () => {
    expect(parseInfoLine('info depth 1 score cp 20 pv e2e4')).toEqual({
      multipv: 1,
      scoreCp: 20,
      mate: undefined,
      pvFirst: 'e2e4',
    })
  })

  it('parses mate scores', () => {
    expect(parseInfoLine('info depth 5 multipv 1 score mate 2 pv f1c4')).toEqual({
      multipv: 1,
      scoreCp: undefined,
      mate: 2,
      pvFirst: 'f1c4',
    })
  })

  it('ignores progress lines without a principal variation', () => {
    expect(parseInfoLine('info depth 8 currmove e2e4 currmovenumber 1')).toBeNull()
    expect(parseInfoLine('readyok')).toBeNull()
  })
})

describe('parseBestMove', () => {
  it('reads the chosen move and ignores the ponder move', () => {
    expect(parseBestMove('bestmove e2e4 ponder e7e5')).toBe('e2e4')
  })

  it('returns null for (none)', () => {
    expect(parseBestMove('bestmove (none)')).toBeNull()
  })

  it('returns null for non-bestmove lines', () => {
    expect(parseBestMove('info depth 1 pv e2e4')).toBeNull()
  })
})

/**
 * Feeds canned UCI output whenever a `go` command is sent, so the search driver
 * can be exercised without booting a WASM engine.
 */
function createScriptedTransport(lines: string[]): UciTransport {
  const listeners = new Set<(line: string) => void>()
  return {
    send: (command) => {
      if (command.startsWith('go')) {
        for (const line of lines) {
          for (const listener of listeners) {
            listener(line)
          }
        }
      }
    },
    onLine: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => listeners.clear(),
  }
}

describe('analyzeViaUci', () => {
  it('ranks MultiPV candidates and keeps the latest score per rank', async () => {
    const transport = createScriptedTransport([
      'info depth 1 multipv 1 score cp 20 pv e2e4',
      'info depth 2 multipv 2 score cp 10 pv d2d4',
      'info depth 2 multipv 3 score cp 5 pv g1f3',
      'info depth 10 multipv 1 score cp 34 pv e2e4 e7e5',
      'bestmove e2e4 ponder e7e5',
    ])

    const analysis = await analyzeViaUci(transport, 'startpos', { multiPv: 3, movetimeMs: 100 })

    expect(analysis.best).toBe('e2e4')
    expect(analysis.candidates).toEqual([
      { uci: 'e2e4', rank: 1, scoreCp: 34, mate: undefined },
      { uci: 'd2d4', rank: 2, scoreCp: 10, mate: undefined },
      { uci: 'g1f3', rank: 3, scoreCp: 5, mate: undefined },
    ])
  })

  it('truncates candidates to the requested MultiPV width', async () => {
    const transport = createScriptedTransport([
      'info depth 4 multipv 1 score cp 12 pv e2e4',
      'info depth 4 multipv 2 score cp 8 pv c2c4',
      'info depth 4 multipv 3 score cp 3 pv b1c3',
      'bestmove e2e4',
    ])

    const analysis = await analyzeViaUci(transport, 'startpos', { multiPv: 2, movetimeMs: 100 })

    expect(analysis.candidates.map(candidate => candidate.uci)).toEqual(['e2e4', 'c2c4'])
  })

  it('falls back to the top candidate when bestmove reports (none)', async () => {
    const transport = createScriptedTransport([
      'info depth 6 multipv 1 score mate 1 pv d1h5',
      'bestmove (none)',
    ])

    const analysis = await analyzeViaUci(transport, 'startpos', { multiPv: 1, movetimeMs: 100 })

    expect(analysis.best).toBe('d1h5')
  })
})
