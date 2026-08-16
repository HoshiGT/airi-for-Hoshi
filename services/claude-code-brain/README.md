# @proj-airi/claude-code-brain

Serves your **Claude subscription** (through the Claude Agent SDK, i.e. Claude Code's engine) as a local OpenAI-compatible chat endpoint, so AIRI can use Claude as her consciousness model without metered API billing.

## What it does

- Exposes `POST /v1/chat/completions` (SSE streaming + non-streaming) and `GET /v1/models` on `127.0.0.1:14515`.
- Translates AIRI's OpenAI-shaped chat (system prompt = character card + toolset prompts, full message history) into an Agent SDK `query()` call with built-in tools disabled — Claude only talks; it never touches your filesystem or terminal.
- **Prompt-cache reuse**: AIRI is stateless and resends the whole history every turn, which would re-price the growing transcript at full rate each message. Instead the bridge keeps one SDK **session per conversation** and `resume`s it, sending only the new turn — so the stable prefix is cache-*read* (0.1x) instead of cache-*created* (1.25x), the way Claude Code stays cheap across a long chat (measured ~10x cheaper on the transcript). Sessions are keyed off the user-message sequence (never the reply, which AIRI strips markers/reasoning from). Pure text turns take this path; tool turns fall back to replaying full history and invalidate the session. Toggle with `CLAUDE_BRAIN_SESSIONS`.
- **Tool passthrough**: AIRI's own tools (desktop control, web search, ...) are re-registered as capture-only in-process MCP tools. When Claude calls one, the bridge intercepts the call before execution and returns it to AIRI in OpenAI `tool_calls` format; AIRI executes it (screenshot, mouse move, search) and calls back with the result.
- **Image passthrough**: base64 images in user messages and tool results (e.g. `desktop_look` screenshots) are forwarded as real Anthropic image blocks — but only from the round currently being answered; older screenshots are dropped to keep requests small.
- Thinking deltas are filtered out; only reply text reaches AIRI, so `<|EMOTE_...|>` / `<|STICKER_...|>` markers work as usual.
- Billing goes against your Claude subscription's usage window, **not** an API key.

## How to use it

1. Make sure this machine is logged into Claude Code (or run `claude setup-token`, or set `CLAUDE_CODE_OAUTH_TOKEN`).
2. Start it — usually automatic: the root `pnpm dev`, `pnpm dev:web`, `pnpm dev:tamagotchi`, and `pnpm dev:tamagotchi:xwayland` scripts launch this bridge in parallel with the stage app (the `dev:xwayland` script here is an alias of `dev` that exists only so pnpm's `--parallel run dev:xwayland` picks this package up too). To run it standalone: `pnpm -F @proj-airi/claude-code-brain start`. If an instance is already listening on the port, the new one logs a notice and exits quietly so the running instance keeps serving.
3. In AIRI: Settings → Providers → **OpenAI Compatible** → baseUrl `http://localhost:14515/v1/` (any non-empty API key works; it is ignored).
4. Settings → Modules → Consciousness → pick this provider and a model (`default` = your Claude Code default; or `claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5`).

Environment knobs:

- `CLAUDE_BRAIN_PORT` — listen port (default `14515`).
- `CLAUDE_BRAIN_EFFORT` — `low` | `medium` | `high` (default `low`; chat latency beats reasoning depth).
- `CLAUDE_BRAIN_SESSIONS` — prompt-cache session reuse (default **on**); set `0`/`false` to force the stateless full-history flatten on every turn.
- `CLAUDE_BRAIN_MAX_HISTORY` — cap replayed rounds on the fresh path. Unset/`0` replays the full conversation (default, so the persona keeps her whole memory); a positive integer trims to the last N user rounds to curb tokens on very long chats.
- `CLAUDE_BRAIN_FORWARD_THINKING` — `1`/`true` to stream Claude's thinking to AIRI as `reasoning_content`, shown as a collapsible "thinking" disclosure above the reply; thinking is adaptive — casual chat gets none, hard questions get a summarized first-person trace at any effort level. Off by default because the trace may still reference system-prompt internals.

## When not to use it

- Heavy traffic (e.g. a busy QQ group) drains the same subscription quota you use for coding — keep the QQ allowlist tight or route casual chatter to a local model.
- Never expose the port beyond localhost; it proxies a paid subscription with no auth of its own. The API key AIRI asks for is ignored entirely — fill in anything.
- Tool-heavy loops (desktop control sessions) make many model turns in quick succession and burn quota accordingly.
