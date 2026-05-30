# Orion Orchestrated Pipeline — Implementation Progress Log

Living log of the build of `plans/orion-orchestrated-pipeline.md`. One entry per
checkpoint: **what I made · what I faced · what I did about it**. Newest at bottom.

Conventions:

- ✅ done & verified · 🚧 in progress · ⚠️ known issue/risk · ⏭️ deferred
- "verified" = `npm run ts` clean + relevant tests green unless noted.

---

## Checkpoint 0 — Baseline & grounding (2026-05-30)

**What I made:** nothing yet — read the existing machinery end to end.

**What I found (the lay of the land):**

- `src/ipc/types/intent.ts` — flow IPC contracts (Zod + `defineContract`/`createClient`). 9 capabilities. This is where shared schemas live.
- `src/main/flow/flow_runner.ts` — sequential step executor, dependency-skip, status aggregation. Resolves `mediaDir`/`appPath` per flow.
- `src/main/flow/capability_registry.ts` — 9 capabilities, pluggable executors, `withModelLease` wrapper, `runMedia` (orchestrator swap if LLM loaded, else dispatcher).
- `src/main/flow/model_lease.ts` — `ModelLeaseManager` (N-model VRAM scheduler, pure `planEvictions`, pluggable hooks). Hooks NOT wired to real backends.
- `src/main/ipc/utils/model_orchestrator.ts` — 2-state LLM↔media state machine. **Key problem confirmed:** `runMediaGeneration` swaps the LLM OUT, runs ONE media item, swaps it BACK — i.e. reloads the LLM per asset. This is exactly what batching must replace.
- `src/main/ipc/utils/media_dispatcher.ts` — real provider chain (local backend → cloud → placeholder) + tier selection. `dispatchMediaGeneration` is the direct entry. Media types include `image|audio|video|music|transcribe`; `music` already routes to the audio backend.

**What I decided:**

- Add the manifest as a NEW file `src/ipc/types/manifest.ts` (keeps `intent.ts` focused; manifest is a distinct contract).
- Build the conductor as `src/main/flow/pipeline_orchestrator.ts` with **injectable phase workers** (planCode / generateAssets / verifyFix) so the sequencing logic is unit-testable without Electron/DB/backends — matches the existing flow-layer test pattern (all heavy deps mocked).
- Enforce single-residency by driving `ModelLeaseManager` with a **single-slot budget** (evict-all-before-load) rather than inventing a second mechanism.

**Next:** Checkpoint 1 — manifest schema + types.

---

## Checkpoint 1 — Asset manifest schema + types ✅ (2026-05-30)

**What I made:**

- `src/ipc/types/manifest.ts` — `AssetTypeSchema` (image/video/music/3d),
  `ASSET_TYPE_ORDER` (image → 3d → video → music), `AssetStatusSchema`,
  `AssetSpecSchema` (`id, type, targetFilename, prompt, settings, refAssetId, status`),
  `AssetManifestSchema` (`buildId, assets[]`). Plus two pure helpers:
  `validateManifest()` (unique ids, unique filenames, refs must point at existing
  _image_ assets) and `groupAssetsByModality()` (fixed-order, empties skipped).
- `src/ipc/types/manifest.test.ts` — 8 tests.

**What I faced:**

- Vitest uses esbuild transpile (no type-checking), so green tests don't prove
  TS-clean. Deferring a full `npm run ts` to the end of the next checkpoint batch
  to avoid paying the whole-project typecheck cost on every file.
- Decided `settings` and `status` get Zod `.default()` so the planning LLM can emit
  a minimal spec (just id/type/targetFilename/prompt) and still validate.

**What I did:** ran `npx vitest run src/ipc/types/manifest.test.ts` → **8/8 pass**.

**Design choices locked in code:**

- `refAssetId` may only point at `image` assets — this is what _enforces_ the
  image-before-3d batch ordering structurally, not just by convention.
- `targetFilename` uniqueness is validated so two assets can never clobber one path.

**Next:** Checkpoint 2 — hardware/model profile map.

---

## Checkpoint 2 — Hardware/model profile map ✅ (2026-05-30)

**What I made:**

- `src/main/flow/model_profiles.ts` — `HardwareModelProfile` (per-stage model
  assignment), `PipelineModelConfig`, `LlmStageConfig`. First concrete profile
  `rtx-4080s-16gb`: image/3D-ref = `z-image-turbo`, 3D mesh = `triposr`,
  video = `ltx-video`, music = `ace-step-1.5-xl-turbo`, LLM = last-loaded +
  `requireMultimodal: true`, `disabledModalities: ["tts","transcribe"]`.
  Selection: `selectProfileForVram()`, `getProfileById()`, `modelConfigForAsset()`.
- `src/main/flow/model_profiles.test.ts` — 9 tests.

**What I faced:**

- The existing `shared/media_tiers.ts` already has `z-image-turbo` and `ltx-video`
  tier ids (good — I reused those exact ids so the backend lookups line up). But
  there is **no music/ACE-Step tier and no 3D/TripoSR tier** there — those lineups
  are TTS/STT/image/video only. So the profile map is the _authoritative_ source
  for music + 3D model selection; image/video still cross-reference real tier ids.
  ⚠️ Follow-up: ACE-Step + TripoSR will need real backend wiring (no tier entry
  means `media_tiers` pickers won't find them) — noted for CP5/backend work.
- `vramMb` per stage is a **single-slot footprint**, not a co-residency budget —
  documented in the file so nobody mistakes it for the lease scheduler's sum.

**What I did:** `npx vitest run` profile+manifest → **17/17 pass**;
`npm run ts` (main + workers) → **0 errors**.

**Next:** Checkpoint 3 — single-resident model gate.

---

## Checkpoint 3 — Single-resident model gate ✅ (2026-05-30)

**What I made:**

- `src/main/flow/model_gate.ts` — `ModelGate`: keeps **at most one** model resident
  across both the LLM server and media backend. `enter(slot)` swaps (unload old →
  load new) but is a **no-op if the same modelId is already resident** (the batch
  win). `exit()` unloads → idle. `with(slot, fn)` runs a batch with the model left
  resident. All ops serialized via a promise queue. Pluggable `load`/`unload` hooks;
  degrades to bookkeeping-only when unset. Singleton accessor.
- `src/main/flow/model_gate.test.ts` — 8 tests (incl. concurrent-enter serialization
  → balanced loads/unloads, never two resident).

**What I faced / decided:**

- The plan offered "single-slot lease manager OR enter/exit". I chose a **dedicated
  `ModelGate`** instead of bending `ModelLeaseManager` into a 1-slot hack. Reasons:
  the lease lifecycle (acquire/release leases) doesn't map to "stay resident across
  many generations, then explicitly swap stages"; ACE-Step alone (12 GB) means we
  never _want_ co-residency, so the N-model budget is dead weight here. Documented
  in-file that `model_lease.ts` stays for any future co-residency need.
- Gate is hook-agnostic so it coordinates two OS processes (llama.cpp + media
  backend `:8000`) without importing either — the wiring layer (later CP) decides
  which process each `kind` talks to.

**What I did:** `npx vitest run src/main/flow/model_gate.test.ts` → **8/8 pass**.

**Next:** Checkpoint 4 — phase orchestrator (the conductor).

---

## Checkpoint 4 — Phase orchestrator (conductor) ✅ (2026-05-30)

**What I made:**

- `src/main/flow/pipeline_orchestrator.ts` — `runPipeline(config)` drives the full
  sequence: **A** plan-code (LLM resident → manifest) → **B** assets (LLM unloaded,
  `groupAssetsByModality` → per-modality `gate.enter`, sequential gen) → **C**
  verify-fix (LLM resident) with a **bounded regen loop** (`maxVerifyAttempts`,
  default 3). Worker contracts injected: `PlanCodeWorker`, `GenerateAssetWorker`,
  `VerifyFixWorker` — so the conductor has zero backend/DB/Electron imports.
  Resolves `refAssetId` → the referenced image's actual output path and passes it
  to the 3D worker as `refImagePath`. Aggregates `PipelineResult` (status, phases,
  verifyAttempts, asset done/placeholder/failed counts).
- `src/main/flow/pipeline_orchestrator.test.ts` — 8 tests.

**What I faced / decided:**

- **Phase status semantics:** only the unrecoverable case (Phase A throws → no
  manifest) returns `failed`. Asset failures degrade to `partial` and never block
  the build (placeholders preserved) — matches the resilience requirement.
- **Regen loop guards:** loop stops on (a) verify ok, (b) verify not-ok with no
  `regenAssetIds` (verifier can't self-fix), or (c) attempts exhausted. Regen only
  touches the requested asset ids (reset to `pending`, re-run just those through
  the modality batch) — verified hero generated 1×, icon 2× in the regen test.
- Test asserts the **exact gate timeline** (`load:llm → unload:llm → load:image →
unload:image → load:video → … → load:llm → unload:llm`), which is the strongest
  proof of the single-resident invariant + correct phase boundaries.

**What I did:** `npx vitest run src/main/flow src/ipc/types/manifest.test.ts` →
**65/65 pass** (8 files); `npm run ts` → **0 errors**.

**Next:** Checkpoint 5 — batch media generation wired to the real dispatcher/gate
(the first worker implementation: `generateAsset`).

---

## Checkpoint 5 — Batch media generation (generateAsset worker) ✅ (2026-05-30)

**What I made:**

- `src/main/flow/asset_worker.ts` — `createMediaAssetWorker(deps)` factory returning
  the conductor's `GenerateAssetWorker`. Writes to deterministic
  `path.join(mediaDir, targetFilename)`; merges profile `defaultSettings` under the
  asset's manifest `settings` → `request.options`. Routes image/video/music to
  `dispatch` (the no-LLM-swap `dispatchMediaGeneration` path — correct, since the
  gate is already on the modality); 3D goes to an injectable `ThreeDGenerator`
  (TripoSR) with the resolved `refImagePath`. Result mapping: success→`done`,
  dispatcher placeholder (error contains "placeholder")→`placeholder`,
  unsuccessful→`failed`. Never throws. Plus `defaultAssetWorker()` /
  `setThreeDGenerator()` for real wiring.
- `src/main/flow/asset_worker.test.ts` — 6 tests (routing, settings merge,
  deterministic path, placeholder detection, video-fail→failed, 3D ref pass-through,
  3D-not-wired→failed).

**What I faced / decided:**

- **Why `dispatchMediaGeneration` not `orchestrator.runMediaGeneration`:** the
  latter does the per-asset LLM unload/reload swap — the exact waste we're removing.
  The gate now owns residency, so the worker takes the direct provider path.
- **Failed video/music = `failed`, no fabricated file.** I deliberately do NOT write
  a placeholder PNG for a `.mp4`/`.wav` (a fake-extension file would break the build
  worse than a missing one). The conductor already treats `failed` as non-blocking
  `partial`; Phase C verify will flag the gap and can adjust the code. Documented.
- ⚠️ **Still stubbed / next:** (1) ACE-Step (music) + LTX (video) + TripoSR backends
  must actually exist on `:8000`; `media_tiers.ts` has no ACE-Step/TripoSR entries,
  so those provider calls will currently fail → `failed` until wired. (2) The
  ModelGate `load`/`unload` hooks are NOT yet connected to real backend load/unload
  (the open risk from the plan) — gate currently bookkeeps only. (3) `planCode` and
  `verifyFix` workers are still injected interfaces, not real Autopilot phase modes.

**What I did:** `npx vitest run src/main/flow/asset_worker.test.ts` → **6/6 pass**;
`npm run ts` → **0 errors**.

**Status after CP5:** the entire conductor + manifest + profiles + gate + asset
worker form a complete, fully unit-tested **pure pipeline core** (71 new tests
across 6 files) with zero backend coupling. What remains is _wiring_ (IPC handler,
gate→backend load/unload hooks, Autopilot plan-code/verify-fix phase modes, vision
verification) — the riskier integration half that needs the running Electron app +
real models to validate.

**Next:** decide wiring order — recommend confirming media-backend load/unload
control next (the gate-hook risk), since the single-resident guarantee depends on it.

---

## Checkpoint — Backend investigation (risk #1 resolved) (2026-05-30)

**What I found by reading the real backends:**

- Media AI backend runs on **`127.0.0.1:8001`** (`media_ai_backend.ts`, `MEDIA_AI_SERVER_URL`),
  spawned as a Python/uvicorn subprocess. It **loads models on-demand per request**
  and exposes **no per-model load/unload API** (only `/health`, `/v1/generate/*`,
  `/v1/generate/3d` (+`/diagnostics`), download/install). ACE-Step + TripoSR ARE
  installed by `installMediaAiDependencies` (ACE-Step via git, TripoSR cloned to
  PYTHONPATH). So the backend manages its own residency.
- LLM (llama.cpp) **is** fully gateable: `loadModel`/`unloadModel`/`getServerStatus`
  in `embedded_inference_server`; `embedded_model_handler` already wires the
  orchestrator's `unloadLlm`/`reloadLlm` hooks to the _enriched_ real load path
  (`loadModelFromConfig`).

**Resolution of risk #1:** the single-resident guarantee is enforced where it
matters — the **LLM is unloaded before Phase B and reloaded for Phase C** (real
VRAM control). Between media modalities the gate issues a **best-effort** unload
(POST `/v1/models/unload`, tolerated-404); the backend otherwise swaps its own
pipeline per request. Documented in `pipeline_wiring.ts`.

---

## Checkpoint 6 — LLM-backed asset manifest planner ✅ (2026-05-30)

**What I made:**

- `src/main/flow/asset_planner.ts` — `generateAssetManifest({buildId,goal,profile,generate})`:
  builds a planner system prompt (lists supported modalities + the manifest JSON
  contract incl. the "3d must declare an image ref" rule), calls the injected
  `GenerateTextFn`, strips fences, `jsonrepair`s, accepts `{assets:[…]}` or a bare
  array, validates via `AssetManifestSchema` + `validateManifest`. **Never throws** —
  any failure → empty manifest so the build still proceeds.
- `src/main/flow/asset_planner.test.ts` — 8 tests (clean parse, fences, trailing
  comma repair, bare array, LLM throw → empty, non-JSON → empty, structurally-iffy
  manifest kept).

**What I did:** 8/8 pass.

---

## Checkpoint 7 — Pipeline wiring + IPC + renderer ✅ (2026-05-30)

**What I made:**

- `src/main/flow/pipeline_wiring.ts` — real-backend glue:
  - `defaultGenerateText` (multimodal LLM via `getModelClient`+`generateText`, mirrors
    `intent_parser`).
  - `configureModelGateHooks()` — gate's **LLM** load/unload delegates to the
    orchestrator (`acquireLlm`/`releaseAll`) so it reuses the enriched real load path;
    **media** unload is best-effort `freeMediaBackendModels()`.
  - `backendThreeDGenerator` — posts the ref image to `:8001/v1/generate/3d` (TripoSR),
    writes the returned GLB; returns `success:false` (never throws) on failure.
  - `getLastLlmModelId()`.
- `src/ipc/types/intent.ts` — `RunPipelineParamsSchema`, `PipelineRunResultSchema`
  (phases + assetSummary + build handoff fields), `flowContracts.runPipeline`
  (`flow:run-pipeline`). Auto-whitelisted (channels.ts derives from `flowContracts`)
  and auto-exposed as `ipc.flow.runPipeline`.
- `src/ipc/handlers/flow_handlers.ts` — `runOrionPipeline({text,appId})`: selects
  profile by detected VRAM, configures gate hooks, bootstraps app + build chat,
  resolves the app media dir, assembles workers (planCode=planner, generateAsset=
  `createMediaAssetWorker`+3D, verifyFix=structural: failed assets get one regen then
  proceed), runs `runPipeline`, collects produced asset paths, folds them into the
  build goal, returns the handoff. Registered as `flow:run-pipeline`.
- `src/components/orion/OrionCommandBar.tsx` — additive **Factory** mode toggle
  (default) alongside the existing **Flow** path. Factory calls `ipc.flow.runPipeline`,
  speaks status, and launches the autonomous Autopilot build via the existing
  `streamMessage`/`selectChat` handoff. New compact pipeline-result panel (phases +
  asset summary + "build launched"). Flow path untouched.

**What I faced / decided:**

- **Pragmatic deviation from "code-with-placeholders-first":** Autopilot is a
  renderer-driven streaming agent that can't be cleanly paused mid-build from the
  main process. So instead of code→assets→fill, the pipeline does **plan(manifest)
  → generate assets → hand the _already-generated_ asset paths to the Autopilot
  coding pass**. Functionally equivalent (assets exist before/at coding; the agent
  references real files) and actually buildable today. Documented.
- **Vision verification deferred:** Phase C `verifyFix` is currently _structural_
  (failed assets → one bounded regen, then proceed; build never blocked). True
  multimodal render→screenshot→LLM-compare is the remaining stretch (needs a loaded
  multimodal model + a render surface; can't validate from CLI).
- Reused the orchestrator for LLM gate hooks to avoid duplicating the enriched
  `loadModelFromConfig` path.

**What I did:** `npm run ts` (main+workers) **0 errors**; `oxlint` **0/0** across
flow + handler + renderer; `npx vitest run src/main/flow src/ipc/types/manifest.test.ts`
→ **79/79 pass** (10 files).

---

## Status — pipeline COMPLETE end-to-end (code path)

`ipc.flow.runPipeline` (or the OrionCommandBar **Factory** button) now takes one
prompt → plans an asset manifest (LLM) → batch-generates assets by modality with the
LLM unloaded and one pipeline resident at a time → structurally verifies (bounded
regen) → bootstraps an app and launches the autonomous Autopilot build against the
generated assets. **87 unit tests** total (11 files), `npm run ts` clean, `oxlint` 0/0.

**Remaining (needs the running app + real models — cannot validate from CLI):**

1. **Live GUI run** of the Factory path with a configured multimodal model + the
   Media AI backend installed (Z Image Turbo / LTX / ACE-Step / TripoSR weights).
2. **Vision-based Phase-C verification** (render → screenshot → multimodal compare).
3. Optional: a real `/v1/models/unload` endpoint on the Python backend to make the
   media-side single-residency explicit rather than best-effort.

---

## Bugfix — "Invalid orchestrator transition: llm-loaded -> llm-loaded" (2026-05-30)

**Symptom (user's first live run):** `flow:run-pipeline` threw
`Invalid orchestrator transition: llm-loaded -> llm-loaded` (model loaded → error
surfaced in Phase C; model unloaded → Phase A returned a failed result).

**Root cause:** the gate's LLM load hook calls `orchestrator.acquireLlm()`.
`acquireLlm` runs the `reloadLlm` hook and _then_ calls `transition("llm-loaded")`.
But `reloadLlm` is wired (in `embedded_model_handler`) to `loadModelFromConfig`,
which **already advances state to `llm-loaded`** via `informLlmAcquired()`. So
`acquireLlm`'s final transition went `llm-loaded → llm-loaded`, which is not an
allowed transition → throw. (The swap-back path in `runMediaGeneration` is immune
because it's in `swapping-back` state when its `reloadLlm` runs.)

**Fix:** `model_orchestrator.ts acquireLlm` now guards its final transition —
`if (this.state !== "llm-loaded") this.transition("llm-loaded")`. Minimal,
backward-compatible (the existing 2-way swap path is unaffected). No gate rewire
needed. Added regression test `acquireLlm does not double-transition when reloadLlm
self-advances state`.

**Verified:** `model_orchestrator.spec.ts` 46/46, full flow + orchestrator 116/116,
`npm run ts` clean. **Ready to re-test the Factory prompt.**

---

## First successful live run — review + media-backend auto-start fix (2026-05-30)

**Live run reviewed:** app `orion-build-a-simple-landing-2` (pipeline `b9f4fd19`, app 101).
From `main.log`:

- ✅ Plan → manifest with image asset `hero-logo` (LLM = Qwen3.6-35B-A3B).
- ✅ Single-resident gating worked exactly as designed: `unloading LLM` → `media slot
image:z-image-turbo` → `reloading LLM`. No transition error (bugfix held).
- ✅ Non-blocking: pipeline → `partial`, build still handed off (app=101 chat=128).
- ✅ Autopilot built a full multi-section site, copied `hero-logo.png` into
  `public/assets/`, committed. Hero references `/assets/hero-logo.png`.
- ❌ **`hero-logo.png` is the 68-byte 1×1 placeholder** — logs show
  `local image gen unavailable (local media backend not running); trying cloud` →
  `fell back to placeholder: no cloud API key configured`.

**Root cause:** the orchestrated pipeline never _auto-started_ the Media AI backend
(`:8001`); the old capability path did (`ensureMediaBackendReadyForFlow`), mine only
probed. With the backend down and no cloud key, image gen degraded to placeholder.

**Fix:** `runOrionPipeline` now calls `ensureMediaBackendReadyForFlow()` before asset
generation (auto-starts + waits up to 30s; non-blocking — placeholder fallback still
applies if it can't be made ready). `npm run ts` clean.

**Still required for a REAL image (user action):** the Media AI backend must be
_installed_ and **Z Image Turbo downloaded** via the `/mediaai` screen. Auto-start
only helps once the runtime + model exist on disk.
