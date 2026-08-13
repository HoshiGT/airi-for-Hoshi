---
title: Self-Approved Commands And Cross-Session History Search
date: 2026-08-07
category: chat-and-memory
module: MCP tool proxy, computer-use approval queue, chat tool renderers, memory history
problem_type: security, architecture
component: stage-ui, stage-tamagotchi, computer-use-mcp
severity: critical
applies_when:
  - "Giving the character any capability that acts on the machine (shell, filesystem, PTY)"
  - "Reading an approval or confirmation flow as if it constrained the model"
  - "Adding MCP servers whose tools include their own permission gates"
  - "Wondering why the character cannot recall a conversation that definitely happened"
  - "Deciding whether a Claude Code / Agent SDK permission mode can serve as a safety boundary"
tags:
  - mcp
  - prompt-injection
  - approval
  - computer-use
  - memory
  - history-search
  - tool-gating
---

# Self-Approved Commands And Cross-Session History Search

## Context

Two capabilities were on the list: let the character run shell commands, and let her
search what was actually said in past conversations. Both looked like wiring jobs —
the pieces already existed. One of them was; the other hid a hole that would have
handed an untrusted input source a shell.

## The approval queue does not constrain the model

`computer-use-mcp` already exposed everything needed to run commands:

- `terminal_exec` is a registered MCP tool (`server/register-tools.ts`)
- `policy.ts` hardcodes `requiresApproval = true, riskLevel = 'high'` for it —
  no config short of `approvalMode: 'never'` relaxes that
- a risky action does not execute; it parks as a *pending action* and the tool
  returns `status: 'approval_required'` with a `pendingActionId`
  (`server/action-executor.ts`)
- `runner.ts` / `pty-runner.ts` do the actual execution

Reading that list it is easy to conclude the gate is real. It is not, because
`desktop_approve_pending_action` **is itself an ordinary MCP tool**. Its handler
ends in:

```ts
return await executeAction(pending.action, pending.toolName, { skipApprovalQueue: true })
```

No human anywhere. A model holding both tools can call `terminal_exec`, read the
`pendingActionId` out of its own tool result, call approve, and run the command
without ever mentioning it. `register-tools-pty-approval.test.ts` covers exactly
this path, so it is designed behaviour, not an oversight.

### Why that is fine there and not fine here

The approval queue was built to make a model *pause* and to leave an audit trail
(`session.record({ event: 'approved' })`). For a developer-driven Claude Code
session that is the right trade: the human issued the task, the queue just slows
down the risky steps.

This character's context is different. It carries bridged chat messages, web
search results, and sticker descriptions — text from people who are not the
operator. Any of it can ask for a command. Against that, "the model pauses" is
not a boundary at all; the injected instruction simply tells it to approve.

### The Agent SDK's auto mode does not fix this either

`permissionMode: 'auto'` runs a classifier over each tool call, and the SDK's
`canUseTool` still receives the calls the classifier is unsure about. It is a
genuine improvement over a hand-written `rm -rf` regex, and worth using where it
applies. But the classifier judges *whether the call fits the task context* — and
when the task context is itself an injected QQ message, a shell command fits it
perfectly. It constrains drift, not provenance.

Separately, `claude-code-brain` runs the SDK with `tools: []` and forwards AIRI's
own tools as capture-only MCP handlers, so built-in `Bash` would execute inside
the bridge process, invisible to AIRI's UI. `canUseTool` is a callback awaiting a
return value in that process, and there is no reverse channel from the renderer
to answer it. That path was abandoned for this reason.

## Fix: approving is a human capability

Two layers, both required, in `packages/stage-ui/src/tools/mcp.ts`:

1. `builtIn_mcpListTools` filters the approval tools out of what the model
   discovers.
2. `builtIn_mcpCallTool` **refuses them on the call path**. Filtering discovery
   alone is not enough: the pending response quotes the approve tool's name and
   the id to pass it, so the name is already in the model's context. The refusal
   text tells the model what to do instead (show the user the command, wait),
   because a bare error just gets retried.

Matching is on the bare tool name via `isHumanOnlyMcpTool`, not the qualified
`server::tool` name — the server key comes from user settings, so gating on the
qualified name would let a rename re-expose the gate.

The host UI is unaffected: it calls its `McpToolRuntime` directly, which is not
filtered. That asymmetry *is* the boundary — model-facing proxy filtered, host
path open.

### Rendering the decision

`command-approval-block.vue` (tamagotchi renderer, registered for
`builtIn_mcpCallTool`) turns a parked command into an inline card with the literal
command, cwd, risk level and Run / Don't run buttons.

Two details that are load-bearing:

- **The command text is read from the server's pending record, not from the
  model's request arguments.** The card exists so the user sees what will actually
  run; sourcing it from the request would show them the asked-for text even if
  something else got queued.
- **The outcome is fed back as a `[system]` user turn.** The decision happens
  outside the model's turn, so it never receives a tool result for the parked
  call — without the follow-up message it waits forever.

Every MCP call reaches chat under the single name `builtIn_mcpCallTool`, so the
renderer parses each turn (`tools/mcp-pending-approval.ts`) and falls back to the
default tool-call block whenever it is not a parked command.

### What is still open

- Only `terminal_exec` / `pty_create` get a card. Clicks, typing and clipboard
  reads also park for approval and still render as generic tool calls.
- `computer_use` is intentionally **not** mounted in the MCP settings yet. The UI
  is ready; mounting it is the deliberate last step.

## History search: the gap was cross-session, not compaction

Consolidation stopped trimming the live context by default
(`trimAfterConsolidation`), which weakened the "the conversation got compacted
away" story. The real gap was different: `memory_recall` only searches distilled
`memory_items`, so "what did we decide about Android last time" fails when *last
time* was a different session — the words exist, but only in that session's raw
messages.

`history_search` / `history_read` (`stores/chat/memory/history.ts`,
`tools/history.ts`) search raw conversation text across every session of one
character, plus `archived_summaries` (both the narrative summary and the
`rawMessages` of genuinely trimmed rounds).

Three decisions worth keeping:

- **Dedupe live against archived by message id.** With trimming off, most
  archived rounds still exist verbatim in the live session; scanning both
  independently surfaced every old turn twice with two different provenances.
- **Require ~60% of the query's distinct tokens** unless the query appears
  verbatim. `tokenize` emits one token per Han character, so an unguarded
  threshold makes "上次聊 Android" match anything containing 上, 次 or 聊.
- **`splitRounds` moved from private to exported** in `trim.ts`. Round numbers
  are a cross-module contract — `memory_items.source_round_from` and
  `archived_summaries.round_from` persist them, and history search reports and
  re-reads by them. A second definition of "round" would silently point at
  different messages.

## Lessons

- An approval step is only a boundary if the thing being constrained cannot
  perform the approval. Check who holds the approve capability before trusting
  the queue.
- A permission classifier judges whether an action fits the task. It cannot tell
  you whether the task itself should have been trusted. When the context carries
  third-party text, provenance is the property that matters.
- When a capability's execution, policy and audit already exist, the remaining
  work is usually about *who decides* — and that is the part worth designing
  carefully, not the part to wire up quickly.
- Scoping a search by what the caller passes in (sessions + archives) rather than
  reaching into stores keeps the search logic pure and makes the
  "same character, all sessions" rule a single visible decision at the call site.
