# AIRI Minecraft Service

This workspace runs AIRI's dedicated Minecraft bot. It connects a Mineflayer runtime to a Minecraft server, loads the cognitive stack in `src/cognitive`, and bridges status, context, and command traffic back to AIRI so the Stage settings shell can observe the service.

## Deprecation Notice

This service is on a deprecation path. The current Mineflayer-based bot is expected to be replaced by a Fabric mod based runtime, which will become the primary Minecraft integration surface going forward.

Use this service for current local development and maintenance, but avoid building new long-term features around the Mineflayer runtime unless they are also part of the migration plan.

## Safety Notice

Do not connect this bot to public servers you do not trust.

The runtime can execute JavaScript-generated action plans to control the bot. Those scripts run in an isolated environment, but they still drive a real local process with access to your Minecraft session, local network reachability, and other machine-side resources. A malicious or hostile server can still cause unwanted actions, or damage to your system.

Treat this service as a local-development and trusted-server tool only.

## Setup

1. Install workspace dependencies from the repo root:

   ```bash
   pnpm i
   ```

2. Copy the template:

   ```bash
   cp services/minecraft/.env services/minecraft/.env.local
   ```

3. Edit `services/minecraft/.env.local`.

4. Start the service:

   ```bash
   pnpm -F @proj-airi/minecraft-bot dev
   ```

   Or, from `services/minecraft/`:

   ```bash
   pnpm dev
   ```

5. The bot should automatically connect to both AIRI and the Minecraft server.

## Cognitive Architecture

AIRI's Minecraft agent is built on a **four-layered cognitive architecture** inspired by cognitive science, enabling reactive, conscious, and physically grounded behaviors.

### Architecture Overview

```mermaid
graph TB
    subgraph "Layer A: Perception"
        Events[Raw Events]
        EM[Event Manager]
        Events --> EM
    end

    subgraph "Layer B: Reflex (Subconscious)"
        RM[Reflex Manager]
        FSM[State Machine]
        RM --> FSM
    end

    subgraph "Layer C: Conscious (Reasoning)"
        ORC[Orchestrator]
        Planner[Planning Agent (LLM)]
        Chat[Chat Agent (LLM)]
        ORC --> Planner
        ORC --> Chat
    end

    subgraph "Layer D: Action (Execution)"
        TE[Task Executor]
        AA[Action Agent]
        Planner -->|Plan| TE
        TE -->|Action Steps| AA
    end

    EM -->|High Priority| RM
    EM -->|All Events| ORC
    RM -.->|Inhibition Signal| ORC
    ORC -->|Execution Request| TE

    style EM fill:#e1f5ff
    style RM fill:#fff4e1
    style ORC fill:#ffe1f5
    style TE fill:#dcedc8
```

### Layer A: Perception

**Location**: `src/cognitive/perception/`

The perception layer acts as the sensory input hub, collecting raw Mineflayer signals and translating them into typed events/signals through an event registry + rule engine pipeline.

**Pipeline**:
- Event definitions in `events/definitions/*` bind Mineflayer events to normalized raw events.
- `EventRegistry` emits `raw:<modality>:<kind>` events to the cognitive event bus.
- `RuleEngine` evaluates YAML rules and emits derived `signal:*` events consumed by Reflex/Conscious layers.

**Key files**:
- `events/index.ts`
- `events/definitions/*`
- `rules/engine.ts`
- `rules/*.yaml`
- `pipeline.ts`

### Layer B: Reflex

**Location**: `src/cognitive/reflex/`

The reflex layer handles immediate, instinctive reactions. It operates on a finite state machine (FSM) pattern for predictable, fast responses.

**Components**:
- **Reflex Manager** (`reflex-manager.ts`): Coordinates reflex behaviors
- **Inhibition**: Reflexes can inhibit Conscious layer processing to prevent redundant responses.

### Layer C: Conscious

**Location**: `src/cognitive/conscious/`

The conscious layer handles complex reasoning, planning, and high-level decision-making. No physical execution happens here anymore.

**Components**:
- **Brain** (`brain.ts`): Event queue orchestration, LLM turn lifecycle, safety/budget guards, debug REPL integration.
- **JavaScript Planner** (`js-planner.ts`): Sandboxed planning/runtime execution against exposed tools/globals.
- **Query Runtime** (`query-dsl.ts`): Read-only world/inventory/entity query helpers for planner scripts.
- **Task State** (`task-state.ts`): Cancellation token and task lifecycle primitives used by action execution.

### Layer D: Action

**Location**: `src/cognitive/action/`

The action layer is responsible for the actual execution of tasks in the world. It isolates "Doing" from "Thinking".

**Components**:
- **Task Executor** (`task-executor.ts`): Runs normalized action instructions and emits action lifecycle events.
- **Action Registry** (`action-registry.ts`): Validates params and dispatches tool calls.
- **Tool Catalog** (`llm-actions.ts`): Action/tool definitions and schemas bound to mineflayer skills.

### Vision (the `look` tool)

**Location**: `src/vision/`

Lets the bot render a first-person frame of the world and send it to the model as an image, for the
questions the text world state cannot answer ("is this build straight?", "what is that structure?").

**How a look happens**:

1. The model calls `look` in its planner script. The tool returns text only — a sandboxed tool cannot
   hand back an image.
2. `BotCamera` (`bot-camera.ts`) starts, on first use only, a prismarine-viewer web server plus a
   headless Chromium page and keeps both alive. The first look pays for the browser launch and chunk
   meshing; later ones cost a screenshot.
3. The frame waits in a one-slot mailbox. The brain drains it and attaches it to the **next** user
   message as an image content part, then schedules a follow-up turn so the model sees it promptly.
   Conversation history keeps the text form only, so an image is billed once.

**Version translation**: prismarine-viewer's newest renderer is 1.21.4 while the bot may be on any
1.21.x, and block state ids are not stable across those releases (961 of 1095 blocks shift between
1.21.4 and 1.21.11 — raw ids would draw `redstone_wire` where the world has `diamond_ore`).
`block-state-bridge.ts` rewrites every id in the chunk stream, and `viewer-feed.ts` applies it by
handing the viewer a proxied bot rather than patching the upstream package.

**Known limits**:
- Block entities (chests, signs, beds) are not drawn — a prismarine-viewer limitation.
- Sections dense enough to use direct block storage (>256 distinct states in one 16³ region) render
  as air; the renderer's chunk reader drops them. See the `NOTICE` in `block-state-bridge.ts`.
- Blocks added after 1.21.4 have no counterpart and are drawn as stone.

**Configuration**: `ENABLE_BOT_VISION`, `BOT_VISION_PORT`, `BOT_VISION_WIDTH`, `BOT_VISION_HEIGHT`,
`BOT_VISION_VIEW_DISTANCE` (see `.env`). Needs the Playwright Chromium build:
`pnpm exec playwright install chromium`. Frame size drives image token cost (about
`width * height / 750` tokens per look). The newest frame is mirrored to `data/vision/latest.jpg`
for debugging.

**Tests**: `pnpm exec vitest run src/vision` covers the translation; the render path needs a browser
and is opt-in with `RUN_VISION_RENDER_TEST=1`.

### Event Flow Example

**Scenario: "Build a house"**
```txt
Player: "build a house"
  ↓
[Perception] Event detected
  ↓
[Conscious] Architect plans the structure
  ↓
[Action] Executor takes the plan and manages the construction loop:
    - Step 1: Collect wood (calls ActionRegistry tool)
    - Step 2: Craft planks
    - Step 3: Build walls
  ↓
[Conscious] Brain confirms completion: "House is ready!"
```

### Project Structure

```txt
src/
├── airi/                      # AIRI bridge, module shell, status publishing
├── cognitive/                  # 🧠 Perception → Reflex → Conscious → Action
│   ├── perception/            # Event definitions + rule evaluation
│   │   ├── events/
│   │   │   ├── index.ts
│   │   │   └── definitions/*
│   │   ├── rules/
│   │   │   ├── *.yaml
│   │   │   ├── engine.ts
│   │   │   ├── loader.ts
│   │   │   └── matcher.ts
│   │   └── pipeline.ts
│   ├── reflex/                # Fast, rule-based reactions
│   │   ├── reflex-manager.ts
│   │   ├── runtime.ts
│   │   ├── context.ts
│   │   └── behaviors/idle-gaze.ts
│   ├── conscious/             # LLM-powered reasoning
│   │   ├── brain.ts           # Core reasoning loop/orchestration
│   │   ├── js-planner.ts      # JS planning sandbox
│   │   ├── query-dsl.ts       # Read-only query runtime
│   │   ├── llm-log.ts         # Turn/log query helpers
│   │   ├── task-state.ts      # Task lifecycle enums/helpers
│   │   └── prompts/           # Prompt definitions (e.g., brain-prompt.ts)
│   ├── action/                # Task execution layer
│   │   ├── task-executor.ts   # Executes actions and emits lifecycle events
│   │   ├── action-registry.ts # Tool dispatch + schema validation
│   │   ├── llm-actions.ts     # Tool catalog
│   │   └── types.ts
│   ├── event-bus.ts           # Event bus core
│   ├── container.ts           # Dependency injection wiring
│   ├── index.ts               # Cognitive system entrypoint
│   └── types.ts               # Shared cognitive types
├── composables/
│   ├── config.ts              # Environment schema + defaults
│   ├── runtime-config.ts      # Persisted local runtime config
│   └── bot.ts
├── vision/                    # 👁️ First-person rendering for the `look` tool
│   ├── bot-camera.ts          # Headless browser lifecycle, capture, pending-frame mailbox
│   ├── viewer-feed.ts         # Viewer web server fed by a translated view of the bot
│   └── block-state-bridge.ts  # Block state id translation between MC versions
├── debug/                     # Debug dashboard, MCP REPL, viewer integration
├── libs/
│   └── mineflayer/           # Mineflayer bot wrapper/adapters
├── skills/                   # Atomic bot capabilities
├── plugins/                  # Mineflayer/bot plugins
├── utils/                    # Helpers
├── minecraft-bot-runtime.ts  # Bot lifecycle wrapper for reconnect/reconfigure
└── main.ts                   # Bot entrypoint
```

### Design Principles

1. **Separation of Concerns**: Each layer has a distinct responsibility
2. **Event-Driven**: Loose coupling via centralized event system
3. **Inhibition Control**: Reflexes prevent unnecessary LLM calls
4. **Extensibility**: Easy to add new reflexes or conscious behaviors
5. **Cognitive Realism**: Mimics human-like perception → reaction → deliberation

### Future Enhancements

- **Perception Layer**:
  - ⏱️ Temporal context window (remember recent events)
  - 🎯 Salience detection (filter noise, prioritize important events)

- **Reflex Layer**:
  - 🏃 Dodge hostile mobs
  - 🛡️ Emergency combat responses

- **Conscious Layer**:
  - 💭 Emotional state management
  - 🧠 Long-term memory integration
  - 🎭 Personality-driven responses

## 🛠️ Development

### Commands

- `pnpm dev` - Start the bot in development mode
- `pnpm lint` - Run ESLint
- `pnpm typecheck` - Run TypeScript type checking
- `pnpm test` - Run tests

## 🙏 Acknowledgements

- https://github.com/kolbytn/mindcraft

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
