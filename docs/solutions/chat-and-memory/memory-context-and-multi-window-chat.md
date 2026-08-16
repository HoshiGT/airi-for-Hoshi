---
title: Memory Context Ownership And Multi-Window Chat Costs
date: 2026-08-04
category: chat-and-memory
module: Chat sessions, memory consolidation, desktop windows
problem_type: architecture
component: stage-ui, stage-tamagotchi
severity: high
applies_when:
  - "Adding tools or context that the character is expected to use on its own initiative"
  - "Changing chat session state that another renderer window also holds"
  - "Investigating why switching conversations in the desktop chat window feels slow"
  - "Changing what memory consolidation does to the live conversation"
  - "Adding OS-level integration (autostart, notifications) on Linux"
tags:
  - memory
  - chat-sync
  - broadcast-channel
  - performance
  - vueuse
  - electron
  - linux
---

# Memory Context Ownership And Multi-Window Chat Costs

## Context

One session added in-chat memory tools (`memory_save` / `memory_recall` / `memory_forget`),
conversation rename + delete-undo, autostart-to-tray, and fixed the desktop chat window
feeling slow and snapping back to the previous conversation. The individual changes were
small; almost all of the time went into finding out *why* each symptom existed. The
findings below are the reusable part.

## Guidance

### Distilled memory is worthless until something reads it back

Before this session, `useMemoryService().recall` had **no caller at all**. Consolidation
summarized old rounds, wrote memories and an archived summary into PGlite, trimmed the
rounds out of the live conversation — and nothing ever put any of it back into a prompt.
The feature looked complete from the settings page (memories were visible and editable)
while being, in practice, write-only. The user's report was "上下文好像少了", which was
literally true: every consolidation pass permanently shrank what the character could see.

Two lessons:

- When adding a distillation/compaction step, write the *read* path in the same change.
  A store with no reader is not a feature, and the gap is invisible in unit tests.
- Prefer additive compaction. `trimAfterConsolidation` now defaults to **off**:
  a pass produces memories and a summary for other consumers, and the conversation keeps
  full precision. Trimming is an opt-in for when context length actually hurts.

### Removing "delete" from a pipeline needs a watermark

Trimming had been doing double duty: it also guaranteed a pass never saw the same rounds
twice. With the conversation left intact, round numbers become stable and a second pass
re-distills the same text, duplicating memories.

The fix is a watermark (`latestArchivedRound`, `max(round_to)` over `archived_summaries`)
plus a batch gate (`minNewRounds`) so a non-trimming automatic pass does not fire a model
call per turn. Read the watermark from the table that is **never pruned**:
`consolidation_runs` keeps only the last few undoable passes, so it cannot be the source
of truth for "already summarized".

### Cross-window session state: metas are existence, messages are cache

The desktop app runs several renderer windows over one IndexedDB, with `/` as the chat-sync
authority and `/chat` as a follower. Three separate bugs came from conflating two different
maps in the broadcast snapshot:

- `sessionMetas` is hydrated from the index for **every** known session.
- `sessionMessages` only holds what that window happened to load from IDB.

The follower decided whether to keep its own active session by looking for it in
`snapshot.sessionMessages`, so switching to a conversation the stage window had never
opened made the follower adopt the authority's session — the user saw the chat snap back
to the previous conversation about a second after switching. Keying on `sessionMetas`
fixes it. Likewise `applyRemoteSnapshot` replaced the message map wholesale, discarding
the follower's freshly loaded conversation; it now merges, using the snapshot's metas as
the authority on existence so the merge cannot resurrect a deleted session.

### A liveness heartbeat must not carry a payload request

The authority announced itself every second, and the follower answered every announcement
with `request-snapshot` — so once per second the authority deep-cloned every loaded
session, structured-cloned it over BroadcastChannel, and the follower replaced its entire
session state. Announcements now only trigger a resync when the authority instance
changes, `syncedAuthorityId` is set when a snapshot actually lands (so an unanswered
request still retries), and churn-driven broadcasts are debounced.

### A window that mutates shared state must announce it

`deleteSession` / `renameSession` / `restoreSession` write IDB, but the other window keeps
its own in-memory copy and would re-add the row on its next broadcast. The repo already
has the mechanism for this — the `airi:chat-sessions:rewritten` BroadcastChannel plus
`rehydrateFromDisk()`. Any store mutation that rewrites persisted session state should end
with `notifySessionsRewritten()`.

### Per-message component cost is multiplied by history length

Chat history mounts one action menu per message. Each one was creating two
`useElementBounding` (ResizeObserver + window listeners), a scroll listener on the shared
container, two `useElementVisibility` IntersectionObservers, an animejs timeline, two
reka-ui menu roots — and a `useIntervalFn(..., 50)` that, because **`immediate` defaults to
`true`**, started a 20 Hz timer at mount and only paused on the first `touchend`, which
never arrives on a desktop. Several hundred messages meant thousands of ref writes per
second, and every session switch tore all of it down and rebuilt it.

All of that exists to place a hover affordance that cannot be seen before the pointer
arrives. The fix is to gate the *inputs*: VueUse composables must be called
unconditionally (they own effect scopes), but passing refs that stay `null` until first
`pointerenter` / `focusin` / `contextmenu` / `touchstart` means an untouched message binds
nothing. When auditing a list-rendered component, count what one row costs and multiply.

### Rendering caches belong at the output, not just the pipeline

`useMarkdown` cached configured processors but not rendered HTML, so re-mounting identical
messages re-ran remark → rehype → katex → shiki → stringify every time. A module-level
map keyed by the source markdown makes re-mounts free. The same session found a dangling
`fallbackProcessor` reference left by an earlier hoist refactor: `processSync` threw
`ReferenceError` on every call — and it is the fallback path, so the bug turned a degraded
render into a throw inside a `catch`. Grep for *all* references when renaming a binding,
and cover fallback paths with a test, since by definition nothing else exercises them.

### Provider-safe tool schemas lose their constraints

`normalizeNullableAnyOf` collapses `x | null` into `type: ['x', 'null']` so strict
OpenAI-compatible providers accept the schema — which silently drops sibling keywords:
`enum`, `minimum`, `maximum`. Anything built with it must re-validate at execute time.
`memory_save` clamps `importance` into 0..1 and coerces any unrecognized `kind` to
`'long'`, because `kind` is a bare text column and a stray `"medium"` would persist and
then match neither filter.

### Electron OS integration is not uniformly implemented

`app.setLoginItemSettings` is macOS/Windows only — on Linux it is a silent no-op. Autostart
there means writing `$XDG_CONFIG_HOME/autostart/<appid>.desktop`. For AppImage, use the
`APPIMAGE` environment variable rather than `process.execPath`, which points inside a
mount that is gone by the next boot. Persist the *intent* in app config separately from the
OS registration, and reconcile on boot: the OS copy can be removed behind the app's back.

## Why This Matters

Every symptom the user reported ("切换好慢", "卡回原对话", "上下文好像少了") had a cause
one layer below where it appeared, and in each case the repo already contained the right
mechanism — `sessionMetas`, the rewritten-broadcast channel, the processor cache, the
notification helper in the spotlight window. The expensive part was not writing code, it
was finding which existing thing was being used incorrectly.

## When to Apply

- Adding a store, table, or tool whose output nothing reads yet.
- Making a lossy transform (summarize, compact, trim) part of a normal flow.
- Any state that two renderer windows both hold in memory.
- Any component rendered once per list item, especially with observers or timers.
- Any VueUse composable with an `immediate` option inside a list-rendered component.
- Any OS-level capability that "works on my machine" but is platform-gated in Electron.

## Related

- `packages/stage-ui/src/tools/memory.ts` — the memory tools and their toolset prompt
- `packages/stage-ui/src/stores/chat/memory/trim.ts` — watermark + batch gate
- `packages/stage-ui/src/stores/chat/session-store.ts` — `applyRemoteSnapshot` merge, rename/restore
- `apps/stage-tamagotchi/src/renderer/stores/chat-sync.ts` — authority/follower snapshot protocol
- `packages/stage-ui/src/components/scenarios/chat/components/action-menu/index.vue` — interaction gating
- `apps/stage-tamagotchi/src/main/libs/electron/login-item.ts` — platform-aware autostart
