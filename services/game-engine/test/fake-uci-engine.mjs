// A minimal UCI engine used by engines.test.ts so the pool is exercised over a
// REAL child process (spawn, stdio line buffering, exit) instead of mocked
// Node built-ins.
//
// Behaviours the tests rely on:
// - `go movetime N` answers after ~N ms; an overlapping `go` (one arriving
//   while another is thinking) answers `bestmove XXXX` so serialization
//   violations become visible in results.
// - a `position fen` containing `CRASH` exits the process right after the
//   reply, letting tests cover the respawn path.
// - every `setoption` echoes as `info string option ...` (ignored by the
//   MultiPV parser, observable in raw line tests if ever needed).
import process from 'node:process'
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })

let lastFen = ''
let goCount = 0
let thinking = false

rl.on('line', (raw) => {
  const line = raw.trim()

  if (line === 'uci') {
    process.stdout.write('id name FakeFish\nuciok\n')
  }
  else if (line === 'isready') {
    process.stdout.write('readyok\n')
  }
  else if (line.startsWith('setoption ')) {
    process.stdout.write(`info string option ${line.slice('setoption '.length)}\n`)
  }
  else if (line.startsWith('position fen ')) {
    lastFen = line.slice('position fen '.length)
  }
  else if (line.startsWith('go')) {
    if (thinking) {
      process.stdout.write('bestmove XXXX\n')
      return
    }
    thinking = true
    goCount += 1
    const crash = lastFen.includes('CRASH')
    const movetime = Number(/movetime (\d+)/.exec(line)?.[1] ?? '20')
    setTimeout(() => {
      thinking = false
      process.stdout.write('info depth 1 multipv 1 score cp 10 pv a2a3 a7a6\n')
      process.stdout.write('info depth 1 multipv 2 score cp -5 pv b2b3 b7b6\n')
      process.stdout.write(`info depth 2 multipv 1 score cp ${20 + goCount} pv e2e4 e7e5\n`)
      process.stdout.write('info depth 2 multipv 2 score mate 3 pv d2d4 d7d5\n')
      process.stdout.write('bestmove e2e4 ponder e7e5\n')
      if (crash) {
        process.exit(1)
      }
    }, movetime)
  }
  else if (line === 'quit') {
    process.exit(0)
  }
})
