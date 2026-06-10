# Orion Builder — Phased Roadmap (June 2026)

Where we are: the unification spine (intent → flow runner → 10 capabilities),
single-device model load/unload orchestration (orchestrator state machine +
VRAM lease manager), 1:1 P2P LLM inference sharing, the Autopilot agent with
~60 tools, missions (long-running autonomous tasks with auto-resume), and
YouTube OAuth/publish all exist and work. This plan sequences what comes next.

Ordering principle: each phase makes the next one cheaper. P2P job dispatch
comes before the content pipeline because content generation is exactly the
workload that benefits from distributing modalities across devices.

---

## Phase 0 — Land and harden what's in flight (~1–2 weeks)

Goal: a stable base. No new features until the current branch is solid.

1. Finish and commit the uncommitted work (media-model selection threading,
   single-residency gate, intent parser changes, `OrianBuilderMediaGeneration`).
2. **Mid-flow review checkpoints.** After each modality batch in
   `flow_runner.ts`, reload the LLM (or use the resident small VL model) to
   inspect generated assets against the plan and repair prompts before the
   next batch. The orchestrator state machine already supports the swap; this
   is a flow-runner policy change. This is the single highest-leverage fix for
   small-model plan quality.
3. **Flow resume.** A flow that dies mid-way (crash, power) should resume from
   `priorOutputs` instead of regenerating everything. The missions
   checkpoint/auto-resume infrastructure is the template — either persist flow
   state the same way or run long flows *as* missions.
4. **Swap telemetry.** Log model load/unload durations and VRAM watermarks per
   step so we know the real cost on the 4 GB-GPU minimum target. Document NVMe
   as a practical requirement for low-RAM devices.
5. Extend `e2e-tests/orion.spec.ts` to cover the review-checkpoint and resume
   paths.

Exit criteria: a multi-modality flow survives a forced kill and resumes; plan
repair demonstrably fixes at least the "asset doesn't match goal" failure case.

---

## Phase 1 — P2P job dispatch (~3–5 weeks) — the big unlock

Goal: a flow step runs on whichever trusted peer is best suited, not just
locally. Work-level parallelism only — never split one model across machines.

1. **Extend the compute proxy beyond LLM inference.** Today
   `compute-proxy.ts` handles `INFERENCE_REQUEST` only. Add
   `MEDIA_REQUEST` (and `CAPABILITY_REQUEST` generally): peer receives a
   `MediaGenerationRequest`, runs it through its own dispatcher/lease manager,
   streams progress, returns the asset. Reuse `media-share.ts` for the file
   transfer back.
2. **Placement decision at the lease seam.** `withModelLease` in
   `capability_registry.ts` is the exact insertion point: before acquiring a
   local lease, ask `routing.ts` which node already has the model key resident
   (`loadedModels` is already advertised over the swarm) or has the most free
   VRAM. Score: model-resident > free-VRAM > latency; LAN peers preferred.
3. **Parallel step execution.** `flow_runner.ts` is sequential. Once steps can
   run on different nodes, independent steps (no dependency edge) should run
   concurrently — image batch on peer A while video runs on peer B.
4. **Failure handling.** Peer death mid-job → requeue the step on the next
   best node (local fallback always works because capabilities already degrade
   gracefully). Per-step timeout derived from modality. Idempotent outputs via
   the existing `reserveMediaPath` hashing.
5. **A simple cluster job queue** so two flows (or two users on the network)
   don't double-book one peer's GPU. The lease manager is per-device; this is
   the cross-device layer above it.
6. Trust/safety: only trusted peers, only when "share my compute" is on
   (already modeled); cap concurrent remote jobs per peer.

Exit criteria: on the two-machine setup (i3 laptop + 9950X/4080S desktop), the
laptop issues one Orion command and the desktop transparently executes LLM +
image + video steps, with the laptop assembling the final result. Kill the
desktop mid-video → step requeues or falls back with a clear partial status.

---

## Phase 2 — Automated content pipeline (~4–6 weeks) — the revenue path

Goal: "generate N shorts on topic X, post at optimal times" as one command,
with a human approval gate before anything goes public.

1. **New capabilities** in the registry: `edit_video` (wrap the existing clip
   editing), `generate_post_metadata` (title/tags/hashtags/description via
   LLM, per-platform variants), `publish_content`, `analyze_post_timing`.
2. **Time-based triggers.** Missions auto-advance on events; add wall-clock
   triggers (cron-like) on top. For YouTube specifically, prefer the API's
   native `publishAt` scheduled publishing — upload when convenient, let
   YouTube release it on time, so machines don't need to be awake at post
   time. Use Electron `powerSaveBlocker`/wake handling only for the
   generation window.
3. **Approval queue UI.** Generated content lands in a review queue
   (thumbnail, metadata, scheduled slot); one click approves or edits.
   Full autopilot is a per-channel opt-in *after* the pipeline has a track
   record. This is also the platform-policy shield: YouTube demonetizes
   mass-produced inauthentic content, so quality-per-post beats volume.
4. **Platform rollout order:** YouTube (exists, free API) → X (paid API,
   budget decision) → Instagram (needs business account + Meta app review —
   start the review process early, it takes weeks).
5. **Analytics feedback loop (stretch):** pull post performance back in and
   let the planner adjust topics/timing.

Exit criteria: one command produces a 3-video batch with edits + metadata,
queued for approval, and approved items publish at their scheduled times with
no machine awake at publish time.

---

## Phase 3 — Blender automation (~3–4 weeks)

Goal: automated 3D modelling, scene assembly, and animation clips.

1. Headless Blender runner (`blender --background --python script.py`) managed
   like the watchdog Python runtime (detector + installer pattern already
   exists in `src/main/watchdog/`).
2. `generate_3d_scene` capability + `setBlenderExecutor`, following the
   existing executor-injection recipe. LLM writes `bpy` scripts; TripoSR
   output (GLB) imports as scene objects.
3. **VL-model verification loop:** render a frame, feed the screenshot to the
   resident VL model, compare against the goal, regenerate the script on
   mismatch. Same QA-gate pattern as the browser gate.
4. Animation: keyframe scripts + render to clips; clips feed straight into the
   Phase 2 editing/publishing pipeline (3D content for socials = compounding
   value).

Exit criteria: "make a rotating product showcase of a coffee mug, 5 seconds"
produces a rendered MP4 with no manual Blender interaction.

---

## Phase 4 — Game engine integration (~6–10 weeks)

Goal: automated game development. Engine choice: **Godot** — open source,
text-based `.tscn` scenes (diffable, agent-friendly), GDScript is easy for
local LLMs, headless export.

1. Add Godot to `detect_project_stack` / `create_project` so `build_app` can
   target it like web/Android/Windows; project templates for 2–3 genres
   (2D platformer, top-down, puzzle).
2. Headless run + screenshot QA gate (the browser-QA-gate pattern again) so
   the agent can verify the game launches and renders.
3. Asset pipeline hookup: Phase 1–3 capabilities supply sprites, audio, music,
   and 3D models into the Godot project.
4. Export presets (Windows/Android/web) through the existing packaging tools.

Exit criteria: "build a simple 2D platformer with generated art and music"
yields a runnable exported game.

---

## Phase 5 — Mobile + everywhere client (~4–6 weeks, after Phase 1 matures)

Goal: phone (and later watch/TV) as a thin Orion client over the peer
protocol — not a port of the Electron app.

1. Small Android app (React Native or Kotlin) speaking the swarm/peer
   protocol: send commands (text + voice), watch flow progress, approve the
   Phase 2 content queue, receive results.
2. Voice input on device; everything heavy routes to trusted desktop peers.
3. Optional on-device 3–4B LLM (llama.cpp/MLC) for offline intent parsing
   only.
4. Watch/TV later as even thinner notification/approval surfaces.

Exit criteria: from the phone, issue a command, watch the desktop execute it,
approve a scheduled post — desktop screen never touched.

---

## Continuous track — scoped self-improvement

Runs alongside all phases, never as unsupervised self-modification:

- The "adding a capability" recipe in `src/main/flow/README.md` is nearly
  machine-followable. Give the Autopilot agent a guided "create new
  capability" flow: it writes the capability + tests + registry wiring on a
  branch, and a human reviews the PR. The agent extends itself; humans keep
  the merge button.
- Same gate for new tools and new intent-parser keywords.

## Sequencing summary

```
Phase 0  harden ─┐
Phase 1  P2P job dispatch ──► Phase 2 content pipeline ──► revenue
                 │                      ▲
Phase 3  Blender ┴──────────────────────┘ (3D clips feed content)
Phase 4  Godot   (after 1; uses 1–3 asset pipeline)
Phase 5  mobile  (after 1; thin client on peer protocol)
self-improvement: continuous, human-gated
```

Phases 3–5 can overlap with 2 if team bandwidth allows, but Phase 0 → 1 → 2 is
the critical path: 0 and 1 are prerequisites for everything, and 2 is the
first phase that produces external value.
