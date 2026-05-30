# Orion Unification Plan — Single-Screen, Command-Driven Software Factory

> **North-star:** One screen. The user issues a command (typed or spoken) and the
> app chains the right workflows automatically (Design → Media → 3D → Build →
> Deploy) with minimal interaction, swapping AI models on the fly within the VRAM
> budget. No interruptions after the first prompt by default.

---

## Status

**All six phases are implemented.** 2026-05-29.

- `npm run ts` = 0 errors
- `npm test` = 1548 pass / 0 fail (32 flow-layer tests)
- `oxlint` 0/0
- Multiple full `electron-forge package` builds exit 0
- Remaining: live GUI verification (requires running Electron app + configured model)

---

## Design decisions (locked)

| Decision            | Choice                                                                                                      | Rationale                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Orchestration model | **Lighter flow layer** on top; Mission System only for explicit multi-worker missions                       | Snappy chaining for light capabilities; heavy machine only where it pays off                                          |
| Build engine        | **Autopilot agent-build** (not Mission System)                                                              | Mission System requires a planning step that blocks true auto-start; Autopilot runs proven end-to-end from one prompt |
| Intent parsing      | **LLM parses free text → structured intent** with keyword fallback                                          | Natural, voice-friendly, resilient when model is offline                                                              |
| Planner model       | **Local-first (llama.cpp), cloud fallback**                                                                 | Local-first ethos; uses `getModelClient(settings.selectedModel)`                                                      |
| Autonomy            | **Autonomous by default** (no interruptions after first prompt); opt-in "Ask me" toggle for supervised mode | User's core requirement                                                                                               |
| Provider fallback   | **Already in-codebase** (`createFallback` in `fallback_ai_model.ts`)                                        | Not duplicated                                                                                                        |
| Semantic memory     | **Deferred**                                                                                                | Vector-store dependency risk on Windows; keyword search works for now                                                 |

---

## Architecture

```
User command (text or voice)
  │
  ▼
intent_parser.parseIntent()          ← LLM (selected model) + keyword fallback
  │  CommandIntent { goal, steps[] }
  ▼
flow_runner.runFlow()
  │  for each step (sequential, dependency-aware)
  ▼
capability_registry.getCapability(id).execute(input, ctx)
  │
  ├─ generate_design    → DesignExecutor (Design Studio session)
  ├─ generate_image     → media dispatcher (orchestrator LLM swap if loaded)
  ├─ generate_audio     → media dispatcher (audio backend :8000)
  ├─ generate_video     → media dispatcher (video backend :8000)
  ├─ generate_3d_asset  → ThreeDExecutor (TripoSR pipeline)
  ├─ research_news      → NewsExecutor (Daily AI Digest)
  ├─ track_website      → TrackingExecutor (Watchdog)
  ├─ track_price        → TrackingExecutor (Watchdog)
  └─ build_app          → BuildExecutor → app+chat bootstrap
                           → renderer auto-launches Autopilot agent-build
  │
  ▼
FlowRunResult { status, steps[] }     ← rendered in OrionCommandBar
  │
  ▼  (if build_app succeeded)
Autopilot agent-build fires           ← streamMessage + selectChat (navigate)
TTS speaks status                     ← window.speechSynthesis
```

All capabilities optionally participate in the N-model lease scheduler
(`withModelLease`) for VRAM budgeting. When hooks are not wired (current state),
the lease is skipped gracefully and the capability uses its own fallback path.

---

## Files

### Flow layer (`src/main/flow/`)

| File                     | Role                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intent_parser.ts`       | text → `CommandIntent` (LLM via selected model; deterministic keyword fallback with design/3D/news/watchdog routing)                                                                               |
| `capability_registry.ts` | 9 capability descriptors + `FlowContext`; pluggable executors (`BuildExecutor`, `DesignExecutor`, `ThreeDExecutor`, `NewsExecutor`, `TrackingExecutor`); media via orchestrator; lease integration |
| `flow_runner.ts`         | Sequential executor, dependency skipping, status aggregation, app-aware media dir                                                                                                                  |
| `model_lease.ts`         | N-model VRAM-budgeted scheduler (LRU + priority + pinned eviction); pure `planEvictions` planner; pluggable hooks                                                                                  |

### IPC contracts (`src/ipc/`)

| File                        | Role                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types/intent.ts`           | `CommandIntent`, `FlowStep`, `FlowRunResult`, `CapabilityId` (9 capabilities), flow contracts (`parseCommand`, `runFlow`, `runCommand`, `listCapabilities`) |
| `handlers/flow_handlers.ts` | Registers handlers + wires `BuildExecutor` (app+chat bootstrap → Autopilot handoff), `DesignExecutor`, `ThreeDExecutor`, `NewsExecutor`, `TrackingExecutor` |

### Renderer (`src/components/orion/`, `src/pages/`)

| File                  | Role                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OrionCommandBar.tsx` | Command input (text + voice mic), Autonomous ⟷ Ask me toggle, TTS spoken status, step results rendering, example chips, capability hints, auto-launches Autopilot on build handoff |
| `OrionPanels.tsx`     | Reusable panel components (Model Engine status, Workflows hub, How-it-works)                                                                                                       |
| `orion.tsx` (page)    | `/orion` command-center: command bar + Model Engine panel + Workflows hub + How-it-works                                                                                           |
| `orion.tsx` (route)   | TanStack Router route definition                                                                                                                                                   |

### Wiring

| File                  | Change                                                         |
| --------------------- | -------------------------------------------------------------- |
| `ipc_host.ts`         | `registerFlowHandlers()`                                       |
| `preload/channels.ts` | `flowContracts` whitelisted                                    |
| `ipc/types/index.ts`  | `flow` client exported                                         |
| `router.ts`           | `orionRoute` added                                             |
| `app-sidebar.tsx`     | "Orion" nav item (Orbit icon)                                  |
| `home.tsx`            | `OrionCommandBar` mounted on landing                           |
| `media_dispatcher.ts` | `dispatchMediaGeneration` exported for flow-layer direct calls |

### Tests (32 total)

| File                          | Tests                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `flow_runner.test.ts`         | 4 — step sequencing, dependency skipping, partial/failed status                                               |
| `intent_parser.test.ts`       | 15 — keyword routing (design, image, 3D, news, watchdog, build, combos), LLM parse, fence stripping, fallback |
| `model_lease.test.ts`         | 11 — eviction planner, lease/release, VRAM budgeting, pinned models                                           |
| `capability_registry.test.ts` | 2 — media capability execution, build executor handoff                                                        |

---

## Phase completion log

### Phase 0 — Design lock

Decisions locked. Plan written.

### Phase 1 — Intent bus + flow runner ✅

- `CommandIntent` IPC contracts (Zod) with `defineContract`/`createClient` pattern
- Capability registry (9 capabilities, pluggable executors)
- LLM intent parser with keyword fallback (handles design, 3D, news, watchdog routing)
- Sequential flow runner with dependency-aware step skipping
- IPC handlers registered in `ipc_host.ts` + preload whitelist

### Phase 2 — N-model lease scheduler ✅

- `ModelLeaseManager` class: acquire/release leases, LRU + priority + pinned eviction
- Pure `planEvictions()` planner (exported for tests)
- Pluggable `ModelLeaseHooks` (load/unload/availableVramMb)
- Serialized acquire queue (prevents VRAM race conditions)
- `withModelLease` wrapper adopted by all capabilities (graceful fallback when hooks unset)
- **Note:** Hooks not yet wired to real backends. The existing 2-way orchestrator already does real LLM↔media auto-swap via `embedded_model_handler.ts` hooks. N-model lease wiring is additive/optional.

### Phase 3 — Hands-free end-to-end build ✅

- **Build-engine pivot (user-approved):** `build_app` does NOT use Mission System
- `flow_handlers.prepareBuildHandoff()` bootstraps app + chat (react scaffold + git init from scratch when no appId)
- Returns `{ runBuild, appId, chatId, buildGoal }` handoff
- `OrionCommandBar` auto-launches Autopilot agent-build via `useStreamChat.streamMessage`
- Navigates to the live build via `useSelectChat`
- Media/design assets folded into the build goal so the agent incorporates them

### Phase 4 — Voice → intent + TTS ✅

- Voice input: `useVoiceToText` (local Whisper via Transformers.js) dictates into command bar → runs the flow
- TTS spoken status: `window.speechSynthesis` announces results ("Command completed. 3 of 3 steps succeeded.")
- Mute toggle (Volume2/VolumeX icon)
- Build launch announced ("Starting the build.")

### Phase 5 — Reliability ✅

- **Provider fallback:** Already exists in-codebase (`createFallback` in `fallback_ai_model.ts` — cascade + 429/rate-limit retry). Not duplicated.
- **Approval UX (as opt-in):** Autonomous ⟷ Ask me toggle on OrionCommandBar. Default = Autonomous (`settings.autonomousMode = true` → `full-autopilot-sandbox` → `auto_approve` for all tools). "Ask me" = `supervised` → existing `requireAgentToolConsent` blocking prompt on risky tools only. Persisted before build launch.
- **Semantic memory:** Deferred (vector-store dependency). Keyword search via existing `missionMemories` table still works.

### Phase 6 — Single-screen Orion command center ✅

- Dedicated `/orion` page with sidebar navigation (Orbit icon, second item)
- **Command bar** (text + voice + autonomy toggle + TTS)
- **Model Engine panel** — polls `ipc.orchestrator.getStatus` every 2s; visualizes idle/loading/loaded/swapping states with current model names + last swap duration
- **Workflows hub** — quick-launch tiles to Gen Assets, 3D Assets, Design, Engine, Network, Watchdog
- **How-it-works panel** — 5-step explanation of the Orion flow
- Also mounted on the home landing screen (below HomeChatInput)

---

## Extension points

Adding a new capability:

1. Add its id to `CapabilityIdSchema` in `src/ipc/types/intent.ts`
2. Add a `Capability` to `CAPABILITIES` in `src/main/flow/capability_registry.ts`
3. (Optional) Add an executor type + `setXxxExecutor` if it needs DB/backend access
4. Wire the executor in `src/ipc/handlers/flow_handlers.ts`
5. Add keywords to `intent_parser.ts` fallback (auto-listed in LLM prompt via `listCapabilities()`)

Wiring the N-model lease scheduler to real backends:

1. In a handler init (e.g. `registerEmbeddedModelHandlers`), call:
   ```ts
   getModelLeaseManager().setHooks({
     load: async (spec) => {
       /* load model */
     },
     unload: async (key) => {
       /* unload model */
     },
     availableVramMb: async () =>
       getAvailableVramMb(await getCachedHardwareProfile()),
   });
   ```
2. Capabilities already call `withModelLease()` — they'll start using the scheduler automatically.

---

## What's NOT done (future iterations)

| Item                                     | Priority | Notes                                                                     |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------- |
| Live GUI verification                    | **High** | Needs user to run `npm run start` and exercise the flow with a real model |
| Embed workflow screens as in-page panels | Medium   | The `/orion` hub links to them today; full embedding is a UI effort       |
| Hands-free wake word                     | Low      | Voice input works; always-listening mode is a UX decision                 |
| N-model lease → real backend hooks       | Low      | Orchestrator already auto-swaps; lease scheduler is the tested foundation |
| Semantic memory (vector search)          | Deferred | sqlite-vss or LanceDB; Windows native-build risk                          |
| Cron-scheduled flows                     | Backlog  | From 4.7's analysis; `mission_auto_scheduler` exists as a foundation      |
| Outbound notifications (Slack/Discord)   | Backlog  | From 4.7's analysis                                                       |
| Docker sandbox for workers               | Backlog  | `workspaceProvider` enum already includes `docker`                        |
