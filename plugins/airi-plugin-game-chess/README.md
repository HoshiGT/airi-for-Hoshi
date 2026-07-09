# @proj-airi/airi-plugin-game-chess

A gamelet/widget extension that lets AIRI play **international chess** and
**Chinese chess (xiangqi)** on a board rendered inside the tamagotchi widget
window. A local WebAssembly engine computes the position; AIRI (the character
LLM) picks the move and comments in character.

## What it does

- Renders a variant-agnostic board (8×8 chess, 9×10 xiangqi) in an extension-ui
  iframe, with a **Match Setup** panel (variant, Vs AIRI / Two Players, which
  side AIRI plays, difficulty).
- Runs the move engine **locally in the browser (WASM)**:
  - Chess: [`chess.js`](https://github.com/jhlywa/chess.js) rules + Stockfish 18
    (single-threaded `stockfish` build) for analysis.
  - Xiangqi: [`ffish`](https://www.npmjs.com/package/ffish) (Fairy-Stockfish)
    rules + `fairy-stockfish-nnue.wasm` for analysis.
- **AIRI selects the move**: on AIRI's turn the engine produces the top-N ranked
  candidates with evaluations; the board offers them to AIRI over the host
  spark-notify *performance* channel. AIRI replies with in-character commentary
  and a chosen move. If AIRI does not answer in time, the engine's best move is
  played so the game never stalls.

## How to use

- Ask AIRI to play (it calls the `play_chess` tool), or spawn the
  `chess-like-main` extension-ui module directly. `play_chess` accepts optional
  `variant`, `mode`, `airiSide`, and `difficulty`; with no arguments it opens
  international chess, AIRI as Black, normal difficulty, and auto-starts.
- Click a piece to select it, then a highlighted square to move. Use **New
  Match** to return to setup.

## When to use / when not

- Use it on **stage-tamagotchi** (Electron): the gamelet/extension-ui host and
  spark-notify performance channel are wired there.
- Do not expect it on stage-web yet — the web extension host is not wired for
  gamelet orchestration.

## Build & deploy

```bash
pnpm -F @proj-airi/airi-plugin-game-chess build
```

This produces a self-contained, deployable extension in `dist/`:

```
dist/
  extension.airi.json   # manifest (entrypoint "./index.mjs", UI at "ui/index.html")
  index.mjs             # Node entrypoint (defineExtension)
  ui/                   # iframe board UI
    engines/            # Stockfish + Fairy-Stockfish WASM artifacts
```

Copy `dist/` into the host's extension registry directory
(`<userData>/extensions/v1/airi-plugin-game-chess/`), then load it from
**Settings → Devtools → Extension Host**.

> The single-threaded engine builds are used on purpose: they run without
> cross-origin isolation (no `SharedArrayBuffer`), which the asset server does
> not provide. The engines are copied from `node_modules` at build time by
> `scripts/copy-engines.mjs` and are git-ignored.

## Development

```bash
pnpm -F @proj-airi/airi-plugin-game-chess dev:ui      # board UI dev server
pnpm -F @proj-airi/airi-plugin-game-chess test        # unit tests (rules, UCI parsing, move selection)
pnpm -F @proj-airi/airi-plugin-game-chess typecheck
```

Unit tests cover pure logic (rules adapters, UCI MultiPV parsing, the Airi
move-selection envelope). The WASM engines and the full iframe flow are covered
by the Electron scenarios `plugin-chess-widget-flow` and
`plugin-chess-worker-smoke` in `packages/scenarios-stage-tamagotchi-electron`.
