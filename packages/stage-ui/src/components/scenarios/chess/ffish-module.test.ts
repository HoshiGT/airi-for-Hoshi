import { describe, expect, it } from 'vitest'

import { ffishModule } from './ffish-module'

// ROOT CAUSE:
//
// The chess module hung with a blank board in the packaged Electron desktop
// app while stage-web worked fine.
//
// The production renderer is loaded with `window.loadFile`, so the page runs
// over `file://`. The ffish Emscripten glue resolves its wasm through
// `fetch(wasmBinaryFile)` with no catch handler on that chain; fetch rejects
// for the file scheme, the "wasm-instantiate" run dependency is never
// released, and `Module.ready` never settles — so `await ffishModule()`
// pending forever and `loadRules()` never finished. Dev mode and web both
// serve over http(s), which is why only the desktop build was affected.
//
// We fixed this by importing the wasm as a Vite `?inline` data URI and passing
// the decoded bytes as the `wasmBinary` init option, which makes the glue's
// getBinaryPromise() resolve the bytes directly instead of fetching.
// This test loads the real in-app module (including the ?inline import) in
// Node — where any fetch would also fail for a bare path — and proves the
// factory resolves and produces a playable board.
describe('ffishModule (in-app load path)', () => {
  it('resolves without fetch and creates a playable xiangqi board', async () => {
    const ffish = await ffishModule()

    expect(typeof ffish.Board).toBe('function')

    const board = new ffish.Board('xiangqi')
    expect(board.legalMoves().trim().split(/\s+/)).toHaveLength(44)
    board.delete()
  })
})
