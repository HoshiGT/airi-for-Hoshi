import type { UciTransport } from './uci'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { analyzeViaUci, parseBestMove, parseInfoLine, uciHandshake } from './uci'

/**
 * In-memory UCI transport: tests script the engine side by mapping received
 * commands to emitted output lines.
 */
function fakeTransport(respond: (command: string, emit: (line: string) => void) => void) {
  const listeners = new Set<(line: string) => void>()
  const sent: string[] = []
  const emit = (line: string) => {
    for (const listener of listeners) {
      listener(line)
    }
  }
  const transport: UciTransport = {
    send: (command) => {
      sent.push(command)
      respond(command, emit)
    },
    onLine: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => listeners.clear(),
  }
  return { transport, sent }
}

describe('parseInfoLine', () => {
  it('parses a centipawn MultiPV line', () => {
    const info = parseInfoLine('info depth 12 multipv 2 score cp -18 pv e7e5 g1f3')
    expect(info).not.toBeNull()
    expect(info!.multipv).toBe(2)
    expect(info!.scoreCp).toBe(-18)
    expect(info!.mate).toBeUndefined()
    expect(info!.pvFirst).toBe('e7e5')
  })

  it('parses a mate score and defaults multipv to 1', () => {
    const info = parseInfoLine('info depth 20 score mate -4 pv h7h8q')
    expect(info).not.toBeNull()
    expect(info!.multipv).toBe(1)
    expect(info!.mate).toBe(-4)
    expect(info!.scoreCp).toBeUndefined()
    expect(info!.pvFirst).toBe('h7h8q')
  })

  it('returns null for progress lines without a pv', () => {
    expect(parseInfoLine('info depth 8 currmove e2e4 currmovenumber 1')).toBeNull()
    expect(parseInfoLine('bestmove e2e4')).toBeNull()
  })
})

describe('parseBestMove', () => {
  it('extracts the move and ignores the ponder suffix', () => {
    expect(parseBestMove('bestmove e2e4 ponder e7e5')).toBe('e2e4')
  })

  it('returns null for (none) and non-bestmove lines', () => {
    expect(parseBestMove('bestmove (none)')).toBeNull()
    expect(parseBestMove('info depth 1')).toBeNull()
  })
})

describe('uciHandshake', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs uci → setup → isready and resolves on readyok', async () => {
    const { transport, sent } = fakeTransport((command, emit) => {
      if (command === 'uci') {
        emit('id name FakeFish')
        emit('uciok')
      }
      if (command === 'isready') {
        emit('readyok')
      }
    })

    await uciHandshake(transport, {
      setup: send => send('setoption name Threads value 1'),
    })

    // Setup lands between uciok and isready, when setoption is accepted.
    expect(sent).toEqual(['uci', 'setoption name Threads value 1', 'isready'])
  })

  it('rejects when the engine never answers', async () => {
    vi.useFakeTimers()
    const { transport } = fakeTransport(() => {})

    const handshake = uciHandshake(transport, { timeoutMs: 1000 })
    const outcome = expect(handshake).rejects.toThrow('UCI handshake timed out')
    await vi.advanceTimersByTimeAsync(1001)
    await outcome
  })
})

describe('analyzeViaUci', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('collects latest-per-rank candidates and resolves on bestmove', async () => {
    const { transport, sent } = fakeTransport((command, emit) => {
      if (command.startsWith('go')) {
        emit('info depth 1 multipv 1 score cp 10 pv a2a3')
        emit('info depth 1 multipv 2 score cp -5 pv b2b3')
        // Deeper pass overrides rank 1: latest evaluation wins.
        emit('info depth 2 multipv 1 score cp 30 pv e2e4 e7e5')
        emit('info depth 2 multipv 2 score mate 3 pv d2d4')
        emit('bestmove e2e4 ponder e7e5')
      }
    })

    const analysis = await analyzeViaUci(transport, 'FEN', { multiPv: 2, movetimeMs: 100 })

    expect(analysis.best).toBe('e2e4')
    expect(analysis.candidates).toHaveLength(2)
    expect(analysis.candidates[0]).toEqual({ uci: 'e2e4', rank: 1, scoreCp: 30, mate: undefined })
    expect(analysis.candidates[1]).toEqual({ uci: 'd2d4', rank: 2, scoreCp: undefined, mate: 3 })
    expect(sent).toContain('setoption name MultiPV value 2')
    expect(sent).toContain('position fen FEN')
    expect(sent).toContain('go movetime 100')
  })

  it('falls back to the top candidate when bestmove reports (none)', async () => {
    const { transport } = fakeTransport((command, emit) => {
      if (command.startsWith('go')) {
        emit('info depth 1 multipv 1 score cp 1 pv c2c4')
        emit('bestmove (none)')
      }
    })

    const analysis = await analyzeViaUci(transport, 'FEN', { multiPv: 1, movetimeMs: 100 })
    expect(analysis.best).toBe('c2c4')
  })

  it('resolves with collected candidates when bestmove never arrives', async () => {
    vi.useFakeTimers()
    const { transport } = fakeTransport((command, emit) => {
      if (command.startsWith('go')) {
        emit('info depth 1 multipv 1 score cp 7 pv g1f3')
      }
    })

    const analysis = analyzeViaUci(transport, 'FEN', { multiPv: 1, movetimeMs: 100 })
    // Safety timer = movetime + 4000ms headroom.
    await vi.advanceTimersByTimeAsync(4101)
    const result = await analysis
    expect(result.best).toBe('g1f3')
    expect(result.candidates).toHaveLength(1)
  })
})
