# Orion Flow Layer

The unification spine: turn a single command, typed or spoken, into a chained
sequence of capability calls, with automatic model management and hands-free
Autopilot builds. See `plans/orion-unification-plan.md` for the full plan.

## Flow of control

```text
command text -> intent_parser.parseIntent()  (LLM, keyword fallback)
                    |
                    | CommandIntent { goal, steps[] }
                    v
                flow_runner.runFlow()
                    |
                    | for each step (sequential, dependency-aware)
                    v
                capability_registry.getCapability(id).execute(input, ctx)
                    |-- generate_design ------------> DesignExecutor (Design Studio)
                    |-- generate_image/audio/video -> media dispatcher
                    |                                (orchestrator swap if LLM loaded)
                    |-- generate_3d_asset ----------> ThreeDExecutor (TripoSR)
                    |-- research_news --------------> NewsExecutor (Daily AI Digest)
                    |-- track_website/track_price --> TrackingExecutor (Watchdog)
                    `-- build_app ------------------> BuildExecutor -> app+chat handoff
                                                     (renderer launches Autopilot)
                    |
                    `-- local AI work -------------> ModelGate (exclusive slot;
                                                     Marta holds a separate
                                                     companion slot)
                    v
                FlowRunResult { status, steps[] }
```

## Files

| File                                  | Role                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `../../ipc/types/intent.ts`           | IPC contracts + Zod schemas (single source of truth)                            |
| `intent_parser.ts`                    | text -> `CommandIntent` (LLM via selected model; deterministic fallback)        |
| `capability_registry.ts`              | capability descriptors + `FlowContext`; pluggable executors + fallback handling |
| `flow_runner.ts`                      | sequential executor, dependency skipping, status aggregation, resume            |
| `flow_review.ts`                      | mid-flow review checkpoints (LLM repairs pending prompts at batch boundaries)   |
| `flow_run_store.ts`                   | per-run JSON persistence so interrupted flows can be resumed                    |
| `model_gate.ts`                       | two-tier residency: one exclusive LLM/media slot + Marta's companion slot       |
| `../../ipc/handlers/flow_handlers.ts` | registers handlers + wires all executors                                        |

## Hardening (Phase 0)

- **Review checkpoints** — at every modality-batch boundary (a contiguous run of
  same-capability media steps) the injected `FlowReviewer` sees what was just
  generated plus the still-pending prompted steps, and may return prompt
  revisions for the pending steps. Wired to the selected model via
  `createLlmFlowReviewer(defaultGenerateText)` in `flow_handlers.ts`. A reviewer
  failure never fails the flow.
- **Resume** — run state (intent + per-step results) is persisted after every
  step under `<userData>/orion-flow/runs/<flowId>.json`. `flow:list-resumable`
  lists interrupted/failed/partial runs; `flow:resume` re-runs only the steps
  that didn't succeed, re-threading the successful outputs.
- **Swap telemetry** — the model gate times every real model load/unload; the
  flow runner attaches them per step
  (`StepResult.swaps`) and aggregates `FlowRunResult.swapTotals`. The
  orchestrator also logs LLM unload/reload durations for the media swap path.

## P2P job dispatch (Phase 1)

Media steps can run on a trusted peer instead of locally:

- `capability_registry.setRemoteMediaDispatcher(fn)` is consulted before the
  local chain. `null` = run locally; a failed remote result "requeues" the job
  locally (the local chain simply runs as the fallback).
- The real hook is `media-remote.ts` (src/main/compute): the pure policy in
  `media_placement.ts` keeps jobs local unless the user explicitly routed
  compute to a peer, or the local GPU cannot fit the modality's model while a
  capable trusted peer can. Capable peers are ranked: requested model already
  resident > LAN > least-busy GPU > lowest latency.
- Transport: `MEDIA_GEN_REQUEST` / `MEDIA_GEN_CHUNK` / `MEDIA_GEN_ERROR` over
  the Noise-encrypted peer channel (same trust gate as LLM inference). The
  serving side (`media-node.ts`) runs the request through its own media
  dispatcher and streams the file back base64-chunked; placeholders are
  reported as errors so the requester's own fallback chain takes over.
- **Parallel steps** — `runFlow(intent, { maxParallel: N })` executes
  dependency-independent steps concurrently in waves (review checkpoint once
  per wave). Default stays 1 (sequential, per-modality checkpoints); local
  model use is serialized for the entire generation by the exclusive-residency gate,
  so >1 pays off when steps land on different peers.

## Capabilities (9)

| Id                  | Backend                        | Executor hook         |
| ------------------- | ------------------------------ | --------------------- |
| `generate_design`   | Design Studio sessions         | `setDesignExecutor`   |
| `generate_image`    | Media dispatcher (local/cloud) | built-in              |
| `generate_audio`    | Media dispatcher (audio)       | built-in              |
| `generate_video`    | Media dispatcher (video)       | built-in              |
| `generate_3d_asset` | TripoSR pipeline               | `setThreeDExecutor`   |
| `research_news`     | Daily AI Digest                | `setNewsExecutor`     |
| `track_website`     | Watchdog                       | `setTrackingExecutor` |
| `track_price`       | Watchdog                       | `setTrackingExecutor` |
| `build_app`         | Autopilot agent-build          | `setBuildExecutor`    |

## VRAM and setup fallback behavior

Every local AI capability enters the gate's **exclusive** tier. The gate unloads
the previous LLM/media pipeline before the next planned model is admitted, holds
the residency lock for the complete generation, and leaves a flow idle when it
finishes.

Marta, the orchestrator, sits in a second **companion** tier and is exempt from
that rule — she has to stay answerable while a heavy job holds the card. When a
model genuinely cannot fit beside her she is _demoted_ to a CPU placement rather
than unloaded, so her session survives, and restored once there is room. Which
of the two happens is decided by a `ResidencyPolicy` that Marta installs (see
`src/main/marta/residency.ts`); `DEFAULT_RESIDENCY_POLICY` reproduces the
pre-Marta behaviour when she is not running.

Independently of residency, the media dispatcher can still choose a lower tier,
CPU fallback, cloud fallback, or a structured setup-required result when the
selected local backend cannot run.

Current media behavior:

- `generate_image` tries the local media backend, then cloud image generation,
  then writes a placeholder image as a last resort so downstream app builds are
  not blocked by a missing provider.
- `generate_audio` and `generate_video` return a successful step with
  `setupRequired: true`, `setupRoute: "/media-runtime"`, and `plannedOutputPath` when
  the backend cannot produce the asset. The flow becomes `partial`, but
  dependent `build_app` steps still run.
- `generate_3d_asset`, `track_website`, and `track_price` also use structured
  setup-required outputs for missing runtimes or services where possible.

This covers both the low-VRAM failure mode and the concurrency race where a
second command could swap models while the first generation was still active.

## Extension points

- `setBuildExecutor(fn)` - app+chat bootstrap -> Autopilot handoff
- `setDesignExecutor(fn)` - Design Studio session creation
- `setThreeDExecutor(fn)` - 3D asset generation pipeline
- `setNewsExecutor(fn)` - news/headline research
- `setTrackingExecutor(fn)` - website/price tracking
- `ModelGate.setHooks(...)` - real exclusive-tier model load/unload lifecycle
- `ModelGate.setCompanionHooks(...)` - Marta's load/unload/demote/restore
- `ModelGate.setResidencyPolicy(...)` - who gets the GPU, and when Marta yields it

## Adding a capability

1. Add its id to `CapabilityIdSchema` in `intent.ts`.
2. Add a `Capability` to `CAPABILITIES` in `capability_registry.ts`.
3. Optional: add an executor type + `setXxxExecutor` if it needs DB/backend access.
4. Wire the executor in `flow_handlers.ts`.
5. Add keywords to `intent_parser.ts` fallback (auto-listed in LLM prompt).

## Tests

`flow_runner.test.ts`, `intent_parser.test.ts`, `model_gate.test.ts`,
`model_gate_companion.test.ts`, and
`capability_registry.test.ts` run with:

```sh
npm test -- src/main/flow
```

All heavy deps (DB, Electron, `ai`) are mocked. 84 tests across those files.

The Orion E2E regression lives in `e2e-tests/orion.spec.ts`. It covers:

- Home + `/orion` single-screen command center availability.
- Session persistence after navigating away and back.
- A multi-workflow command that touches design, image, 3D, news, website
  tracking, and price tracking.
- The coffee logo + promo-video build path that previously failed with
  `Cannot fit model ... insufficient VRAM` and skipped `build_app`.
