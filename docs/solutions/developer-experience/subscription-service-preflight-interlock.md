---
title: A Preflight Interlock In Front Of A Subscription-Spending Service
date: 2026-08-04
category: developer-experience
module: claude-code-brain
problem_type: operations
component: services
severity: medium
applies_when:
  - "A local service spends a personal subscription rather than a metered API key"
  - "Reaching a provider through a proxy whose exit node can change between sessions"
  - "Adding a start-time safety check that must not be defeated by a reflex keypress"
tags:
  - claude-code-brain
  - egress
  - proxy
  - safety-interlock
  - node-fetch
---

# A Preflight Interlock In Front Of A Subscription-Spending Service

## Context

`claude-code-brain` serves a Claude *subscription* (via the Agent SDK) as a local
OpenAI-compatible endpoint. Unlike an API key, a subscription carries an account
whose apparent origin is part of its fingerprint — so when the machine reaches the
provider through a proxy whose node can rotate, starting the bridge from an
unexpected exit is a risk the user wants to take deliberately, never by default.

The result is a start-time interlock: check the exit IP against a pinned list,
and when it does not match, do not serve.

## Guidance

### Fail closed, and make the override cost something

An unreachable probe endpoint says nothing about where traffic would exit, so
"probe failed" is treated exactly like "wrong IP": the service does not start.
Guessing is the one thing the interlock exists to avoid.

The manual override is **two steps, and the first is a transcription** — type the
detected address, then type `yes`. A single `y/N` would be answered by reflex,
which defeats the purpose; typing an address out cannot happen by accident. When
there is no TTY (the desktop app or a dev script spawned the service), the
override is simply unavailable and the service declines.

### Bind first, gate second, refuse requests in between

The listener binds before the check runs, so a duplicate instance still exits
quietly through the `EADDRINUSE` path without prompting anybody. That leaves a
window between bind and verdict — closed by having the request handler answer
`503` until the gate clears. Without it, a request arriving mid-probe would reach
the provider from exactly the exit under examination.

### Verify that the probe shares the egress path

The trap: **Node's `fetch` ignores `HTTPS_PROXY`/`ALL_PROXY`, while the Claude CLI
the Agent SDK spawns honours them.** With an env-var proxy, a `fetch`-based probe
measures the direct route while the SDK leaves through the proxy — the check would
be confidently wrong. A transparent/TUN-mode proxy has no such split.

This is machine-specific, so it must be *verified*, not assumed. The check that
settles it, run on the machine itself:

```bash
curl -s https://api.ipify.org; echo          # honours proxy env vars
node -e "fetch('https://api.ipify.org').then(r=>r.text()).then(console.log)"
```

Same answer → one egress, the probe is meaningful. Different answers → env-var
proxying, and the probe measures the wrong path. The service logs a warning
whenever it sees proxy env vars rather than implying precision it does not have.

A second-order version of the same trap: even with one egress today, the probe
domain and the provider domain can sit in *different proxy rule groups*, so
switching one group later silently decouples them. Pinning both domains to the
same rule keeps the measurement bound to the thing being measured.

### Endpoint choice does the work `fetch` cannot

`fetch` exposes no address-family control, so there is no `curl -4` equivalent.
Picking an endpoint that publishes A records only (`api.ipify.org`) makes the
answer the IPv4 exit by construction. The response is validated as a bare IP —
a captive portal or proxy error page answers `200` with HTML, and pinning the
guard to that would be worse than no guard.

### The pinned value is configuration, not code

The expected address lives in the service's gitignored `.env`. An exit IP is
user-specific and mildly identifying; it does not belong in the repository. Verify
with `git check-ignore -v <path>` rather than trusting the pattern by eye.

## Why This Matters

Interlocks that are easy to dismiss stop being interlocks. Failing closed, making
the override deliberate, and proving the probe measures the right path are what
separate a real safety check from a reassuring log line.

## When to Apply

- Any local service spending a personal subscription or seat-based credential.
- Any preflight check whose measurement path might differ from the path being protected.
- Any confirmation prompt guarding something the user considers irreversible.

## Related

- `services/claude-code-brain/src/egress-guard.ts` — probe, verdict, two-step confirmation
- `services/claude-code-brain/src/index.ts` — bind-then-gate ordering and the 503 window
- `services/claude-code-brain/README.md` — operator-facing setup and the proxy caveat
