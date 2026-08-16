---
title: Browser-Mode Tests Hang Forever On A Lost BroadcastChannel Handshake
date: 2026-08-13
category: developer-experience
module: stage-ui
problem_type: tooling
component: packages
severity: high
applies_when:
  - "Every *.browser.test.ts hangs after printing the RUN banner, with no error and no timeout"
  - "Vitest browser mode is pinned below 4.1.10"
  - "A test harness deadlocks and you need to prove which side is waiting"
tags:
  - vitest
  - browser-mode
  - playwright
  - broadcastchannel
  - race-condition
  - cdp
---

# Browser-Mode Tests Hang Forever On A Lost BroadcastChannel Handshake

## Context

Every `*.browser.test.ts` in `packages/stage-ui` hung on this machine for over a
month. The run printed its banner and then stopped — exactly 60 bytes of output,
no error, no crash, and no self-timeout. Only an external `timeout` ended it.

Because the harness was the only automated way to exercise rendering code, it
being down let two serious defects reach the repository unverified.

The obvious suspects were all wrong. Playwright's browsers were installed;
`chromium.launch()` on its own succeeded in 162ms; there were no stale processes;
headed mode hung identically; and `vitest`, `@vitest/browser-playwright` and
`playwright` versions all matched.

## Root cause

Vitest browser mode runs tests in an iframe. Two pages coordinate over a
`BroadcastChannel` named `vitest:<sessionId>`:

- the **orchestrator** creates the tester iframe and, on its `load` event, posts
  a `prepare` event and awaits `response:prepare`
- the **tester** registers its channel listener at the *end* of its module
  evaluation

Up to 4.1.9 nothing ordered those two. Instrumenting the live page — hooking
`BroadcastChannel.prototype.postMessage` and the tester realm's constructor —
produced the timeline:

```
184.8ms  iframe readyState = complete
373.2ms  tester creates its BroadcastChannel (module evaluation begins)
375.3ms  orchestrator POSTs "prepare"          <-- sent
390.3ms  tester registers its "message" listener  <-- 15ms too late
391.3ms  tester module finishes evaluating
```

`BroadcastChannel` does not buffer. The `prepare` event was delivered to a
channel with no listener, vanished, and both sides waited forever.

Nothing about it is machine-specific in principle — it is a plain race, and this
package's module graph simply lost it every time.

## Fix

Raise the `vitest` catalog floor to `^4.1.10`, which added the missing readiness
handshake (`markReady` / `waitForReady`): the orchestrator now waits for the
tester to announce itself before posting `prepare`.

Result: from permanent hang to 5 files / 21 tests in 4.41s.

The floor is recorded with its reasoning in `pnpm-workspace.yaml`, because a
future "tidy up the catalog" pass would otherwise read `^4.1.10` as arbitrary.

## Guidance

### A silent hang is a question about which side is waiting

No error means no stack, so the useful move is to interrogate both ends of the
protocol while they are stuck rather than to re-read their source.

The playwright provider accepts `launchOptions`, so the browser can be given a
CDP port it does not normally expose:

```ts
provider: playwright({
  launchOptions: { args: ['--remote-debugging-port=9333'] },
})
```

Playwright otherwise drives Chromium over `--remote-debugging-pipe`, which cannot
be attached to from outside. With the port open, `Runtime.evaluate` reads live
page state — the tester's `__vitest_browser_runner__.method` was still `"none"`
and its `files` still `null`, which located the stall precisely: the tester had
booted completely and was simply never told to run.

### Replaying the lost message proves causation

Posting a duplicate `prepare` on the same channel from the orchestrator page
unblocked the run and the tests passed. That single experiment separated "the
message was lost" from "the message was rejected", which no amount of reading
minified bundles would have settled.

### Poll inside the page, not across CDP

A 100ms CDP polling loop put "orchestrator sent prepare" and "tester became
ready" in the same sample bucket, which is what made the race look like a
mystery instead of a 15ms ordering bug. Injecting a monitor that polls at ~1ms
*inside* the page, and wrapping the API under suspicion, is what resolved the
ordering.

### Collecting output from a hung process

Do not pipe it through `tail`. `tail` buffers until the stream closes, so a
process that never exits appears to have produced nothing — which is how this
was first mis-recorded as "not even the banner is printed". Redirect to a file
(`> out.log 2>&1`) and read the file.

## Why This Matters

The harness is the only automated check for rendering behaviour in `stage-ui`.
While it was down, every change to that layer had to be verified by starting the
app by hand, and defects that a browser test would have caught immediately were
instead found in production.

## Related

- `pnpm-workspace.yaml` — the catalog floor and its `NOTICE`
- `packages/stage-ui/vitest.config.ts` — the `browser` project definition
