# @proj-airi/game-engine

Native UCI board-game engine service for AIRI: Stockfish (chess) and Pikafish
(中国象棋 / xiangqi) behind the AIRI server channel.

## What it does

Connects to a running `server-runtime`, registers as the `game-engine`
consumer group, and answers `game:engine:analyze` requests by driving a native
UCI engine (MultiPV search), replying with `game:engine:analyze:result`
broadcast events correlated by `requestId`. Engines spawn lazily per variant,
requests are serialized per engine, and a crashed engine respawns with one
transparent retry.

## How to use

```bash
# chess needs a stockfish binary (e.g. apt install stockfish), xiangqi needs Pikafish:
export PIKAFISH_BIN=~/.local/share/airi/engines/pikafish/pikafish
export PIKAFISH_NNUE=~/.local/share/airi/engines/pikafish/pikafish.nnue

pnpm -F @proj-airi/game-engine start
```

Environment:

| Var | Default | Meaning |
| --- | --- | --- |
| `AIRI_URL` | `ws://localhost:6121/ws` | server-runtime websocket |
| `AIRI_TOKEN` | _(none)_ | auth token, if the runtime sets one |
| `STOCKFISH_BIN` | `stockfish` (PATH) | chess engine binary |
| `PIKAFISH_BIN` | _(unset = xiangqi disabled)_ | xiangqi engine binary |
| `PIKAFISH_NNUE` | next to the binary | Pikafish `EvalFile` network |
| `ENGINE_THREADS` | `1` | search threads per engine |

A variant whose engine is missing answers with an error result; the in-app
board then falls back to its built-in search.

## When to use / not to use

Use it to give the stage chess module (Settings → Modules → 象棋) full-strength
engines. Don't use it as a general engine RPC for untrusted callers — it
trusts the AIRI channel (auth token) and clamps but does not authenticate
per-request.
