/**
 * Manual end-to-end probe for the game-engine service: connects to a running
 * server-runtime as a plain peer, sends one `game:engine:analyze`, prints the
 * `game:engine:analyze:result`, and exits.
 *
 * Usage (defaults: xiangqi opening, ws://localhost:6121/ws):
 *
 *   pnpm -F @proj-airi/game-engine exec tsx scripts/analyze.ts [chess|xiangqi] ["<fen>"]
 *
 * Call stack:
 *
 * main (this file)
 *   -> {@link Client} (@proj-airi/server-sdk, peer 'proj-airi:game-engine-e2e')
 *     -> send 'game:engine:analyze' {requestId, variant, fen, multiPv}
 *     <- 'game:engine:analyze:result' | 'error' (no consumer) | timeout
 */
import process, { argv, env, exit } from 'node:process'

import { Client } from '@proj-airi/server-sdk'

const START_FEN = {
  chess: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  xiangqi: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
} as const

const variant = (argv[2] === 'chess' ? 'chess' : 'xiangqi') satisfies keyof typeof START_FEN
const fen = argv[3] ?? START_FEN[variant]
const requestId = `e2e-${Date.now().toString(36)}`

const timer = setTimeout(() => {
  console.error('TIMEOUT: no result within 15s')
  exit(1)
}, 15_000)

const client = new Client({
  name: 'proj-airi:game-engine-e2e',
  url: env.AIRI_URL || 'ws://localhost:6121/ws',
  token: env.AIRI_TOKEN || undefined,
  possibleEvents: ['game:engine:analyze', 'game:engine:analyze:result'],
  onReady: () => {
    client.send({
      type: 'game:engine:analyze',
      data: { requestId, variant, fen, multiPv: 3, movetimeMs: 500 },
      metadata: { event: { id: requestId } },
      route: { delivery: { required: true } },
    })
    console.warn(`sent analyze: variant=${variant}`)
  },
})

client.onEvent('game:engine:analyze:result', (event) => {
  if (event.data.requestId !== requestId) {
    return
  }
  clearTimeout(timer)
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(event.data, null, 2))
  client.close()
  exit(event.data.error ? 1 : 0)
})

client.onEvent('error', (event) => {
  if (event.metadata?.event?.parentId !== requestId) {
    return
  }
  clearTimeout(timer)
  console.error(`ERROR: ${(event.data as { message?: string })?.message}`)
  client.close()
  exit(1)
})

process.on('SIGINT', () => exit(130))
