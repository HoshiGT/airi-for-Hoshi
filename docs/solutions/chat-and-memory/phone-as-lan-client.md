---
title: Reaching AIRI From A Phone Over The LAN
date: 2026-08-04
category: chat-and-memory
module: stage-pocket, server channel, memory
problem_type: architecture
component: stage-pocket, stage-tamagotchi, server-runtime
severity: medium
applies_when:
  - "Wanting AIRI's messages (or her proactive nudges) to reach a phone"
  - "Considering syncing chat sessions between two devices"
  - "Deciding where the character's brain and memory should live"
  - "Setting up pairing between the desktop app and stage-pocket"
tags:
  - stage-pocket
  - android
  - capacitor
  - lan
  - websocket
  - memory
  - pairing
---

# Reaching AIRI From A Phone Over The LAN

## Context

The goal: messages should reach the phone, so a PC-side nudge ("she misses you")
is not lost when nobody is at the desk. The instinct was "port AIRI to Android and
sync sessions between the two over the LAN, without cloud sync."

Almost none of that needed building. What it needed was picking the right one of
two architectures — and the inventory below, so nobody rebuilds what is already
there.

## Guidance

### One brain, two screens — not two brains reconciling

Two shapes are possible, and they differ by an order of magnitude in cost:

- **Phone as a client of the PC's AIRI.** The phone sends `input:text` and renders
  `output:gen-ai:chat:message` over the server channel — the exact path `qq-bot` and
  `discord-bot` already use. No backend, no sync protocol, no second model key.
- **Phone with its own brain, sessions reconciled both ways.** Needs storage,
  conflict rules, incremental sync, offline catch-up.

The deciding argument is memory, not effort. **The memory database (PGlite over
IndexedDB) is per-device and is not part of chat sync at all** — chat sync moves
sessions and messages only. Two brains therefore means two memory stores, each
consolidating on its own schedule against its own watermark, diverging from day
one. One brain keeps memory coherent by construction.

Note the irony for anyone avoiding cloud sync: the cloud client
(`libs/chat-sync/cloud-mapper.ts`) talks to `/api/v1/chats` on a **server that is
not in this repository**, and `SERVER_URL` is a build-time constant. Two-way
session sync would mean self-hosting a backend that does not exist here — the
"no cloud" path is the client-only one.

### The LAN pairing loop already exists end to end

Inventory, so it is not rebuilt:

- `apps/stage-pocket` — Capacitor app with `android/` and `ios/`, `pnpm dev:android`.
- `apps/stage-pocket/src/modules/websocket-bridge.ts` — **native WebSocket bridge**.
  This is the piece that makes LAN work at all: a page on a secure origin cannot
  open cleartext `ws://` to a LAN IP, so socket I/O is handed to the native layer
  while the page stays secure.
- Pairing, both ends: `settings/connection/server-channel-qr-card.vue` (desktop,
  renders the QR) and `server-channel-qr-scanner.vue` + `modules/server-channel-qr-probe.ts`
  (phone, scans and probes). The payload carries **multiple candidate URLs** plus the
  auth token, and the phone tries each until one connects — which is how a host with
  several interfaces resolves itself without the user picking an IP.
- Desktop setting **Settings → Connection → "expose on the connected network"**:
  switches the listen host between `127.0.0.1` and `0.0.0.0`, persisted in
  `server-channel/config.json`.
- `getServerChannelQrHosts` builds the QR's URL list from `getConnectionHost()`
  with loopback filtered out — so on `0.0.0.0` the QR contains exactly the LAN
  addresses. On a loopback host it returns nothing and the card shows
  "no reachable private LAN address", which is the intended refusal, not a bug.
- TLS (`wss://`) with certificate trust wiring is already present.

### Keep the subscription bridge off the LAN

`claude-code-brain` binds `127.0.0.1` deliberately — it proxies a paid subscription
with no auth of its own. In the one-brain design the phone never needs it: only the
server channel (6121, token-authenticated) is exposed. Nothing about reaching the
phone requires widening the brain's binding.

Running the brain on the phone is not an option either: it is a Node service using
the Agent SDK, and a Capacitor WebView has no Node runtime.

## Why This Matters

The feature reads as "port to Android + build sync". It is actually "flip one
setting, scan a QR, then add a chat view and notifications" — provided the
architecture question is answered first. Answering it the other way (two brains)
buys a sync backend and a permanently divergent memory.

## When to Apply

- Any second device that should see or send AIRI's messages.
- Any proposal to sync sessions between devices — check what the memory store does
  first; it does not travel with sessions.
- Any feature that seems to need the LAN: check whether the server channel and its
  QR pairing already cover it.

## Next Steps

1. Desktop: Settings → Connection → "本地网络所有人" (`0.0.0.0`); a blank auth token
   auto-generates one.
2. `pnpm -F @proj-airi/stage-pocket dev:android`, phone on the same Wi-Fi.
3. Scan the QR from the desktop connection page; confirm the connection appears in
   the server log. **This is the gate — nothing else is worth building until pairing
   works.** Usual failures: firewall on 6121, or the native bridge.
4. Then: a chat view on the phone (components exist in `stage-ui`), Capacitor local
   notifications so proactive nudges land on the phone, and a visible "not connected"
   state for when the phone leaves the LAN.

## Related

- `apps/stage-tamagotchi/src/main/services/airi/channel-server/index.ts` — host config, QR payload
- `packages/stage-shared/src/server-channel-qr.ts` — payload schema (multi-URL + token)
- `apps/stage-pocket/src/modules/websocket-bridge.ts` — native socket bridge
- `packages/stage-ui/src/stores/chat/memory/` — the per-device memory store this decision protects
