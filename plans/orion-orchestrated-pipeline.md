# Orion Orchestrated Pipeline — Redesign

> **North-star:** One prompt in. A finished, verified product out. Fully autonomous
> in between — the user does not touch the system again until the final result is
> presented. The **orchestrator owns the pipeline**; it drives a fixed sequence of
> phases, and **exactly one model / one pipeline is resident in VRAM at any moment**
> (multiple loads _within_ a pipeline are fine; RAM offload is fine).

Supersedes the autonomy/chaining intent of `orion-unification-plan.md`. That plan
built the seeds (intent bus, flow runner, lease scheduler, command UI). This plan
re-centers control on a **phase orchestrator** and replaces the per-asset LLM swap
with **batch-by-modality** generation driven by an LLM-authored **asset manifest**.

---

## Locked decisions (2026-05-30)

| #   | Decision                                          | Note                                                                                       |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | **Orchestrator owns the pipeline**, not Autopilot | Autopilot is invoked as a phase worker, not the conductor                                  |
| 2   | **Multimodal LLM only**                           | Vision-based verification is in scope from v1; no separate VLM needed                      |
| 3   | **Autopilot runs in phase modes**                 | Phase = the window an LLM is resident. Configure Autopilot with per-phase instruction sets |
| 4   | **One model / one pipeline active at a time**     | Multi-load _inside_ a pipeline (e.g. 3D = image-ref then TripoSR) is allowed               |
| 5   | **RAM offloading allowed**                        | A model may spill to system RAM (64 GB); still logically one active pipeline               |
| 6   | **LLM emits a structured asset manifest**         | The hard contract between planning and asset generation                                    |
| 7   | **Fully autonomous after one prompt**             | User re-engages only at final product                                                      |

---

## Runtime phases (the conductor's sequence)

```
USER PROMPT
   │
   ▼
┌─ PHASE A — PLAN & CODE ────────────────────────── (LLM resident) ─┐
│  • Load LLM (last-loaded engine model + settings; multimodal)      │
│  • Autopilot mode = "plan-code"  (media tools DISABLED)            │
│  • Produces:                                                       │
│     1. Build plan (stack, routes, pages, content structure)        │
│     2. Scaffolded code with PLACEHOLDERS referencing pre-named     │
│        asset files (e.g. /assets/hero-banner.png)                  │
│     3. ASSET MANIFEST (structured: filename + prompt + settings)   │
│  • Persist plan + code + manifest                                  │
│  • UNLOAD LLM                                                      │
└────────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─ PHASE B — ASSET GENERATION ───────────────────── (LLM unloaded) ─┐
│  Orchestrator groups manifest assets by modality, runs groups in   │
│  a fixed order. Per group: load pipeline → generate each asset     │
│  SEQUENTIALLY → write to manifest targetFilename → unload pipeline. │
│                                                                     │
│   1. IMAGES   → Z Image Turbo   (also makes 3D reference images)    │
│   2. 3D       → TripoSR         (consumes refs from step 1)         │
│   3. VIDEO    → LTX Video                                           │
│   4. MUSIC    → ACE-Step 1.5 XL Turbo (12 GB, always solo)          │
│                                                                     │
│  Asset fail → write placeholder, mark status, DO NOT block build.  │
└────────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─ PHASE C — INTEGRATE • VERIFY • FIX • DEPLOY ───── (LLM resident) ─┐
│  • Reload LLM (multimodal)                                          │
│  • Autopilot mode = "verify-fix"                                    │
│  • Steps:                                                           │
│     1. Confirm every manifest asset exists at its targetFilename    │
│     2. Wire assets in (replace placeholders if needed)              │
│     3. Build / typecheck                                            │
│     4. VISUAL VERIFY: render → screenshot → multimodal LLM compares │
│        rendered result against the plan, flags defects              │
│     5. Fix (code edits) or request bounded asset regen (→ re-enter  │
│        Phase B for just that asset, capped retries)                 │
│     6. Test + deploy                                                │
│  • UNLOAD LLM → DONE                                                │
└────────────────────────────────────────────────────────────────────┘
   │
   ▼
PRESENT FINISHED PRODUCT  ← first and only user interaction after the prompt
```

---

## The single-resident invariant

- A global **single GPU slot**: only one of `{ llm, image, video, music, 3d }` loaded
  at once. Before any load, the orchestrator unloads whatever is resident.
- This coordinates **across two processes**: the embedded llama.cpp LLM server and
  the media backend (`:8000`). The orchestrator is the only thing allowed to issue
  load/unload to either.
- Extend `model_orchestrator.ts`: today it's a 2-state LLM↔media swap that reloads
  the LLM after **every** media call. Replace that with explicit
  **`enterPhase` / `exitPhase`** transitions so an entire modality batch runs in one
  window with no LLM thrash. Generalize the resident type from `{llm|media}` to the
  full model-kind set.
- RAM offload is permitted (model may partially reside in system RAM); it does not
  change the "one active pipeline" rule.

---

## The asset manifest (planning↔generation contract)

The linchpin. The planning LLM declares every asset up front; the code references
those exact filenames as placeholders; Phase B fills them. Nothing is discovered
mid-build, which is what makes batching possible.

```ts
AssetManifest {
  buildId: string;
  assets: AssetSpec[];
}

AssetSpec {
  id: string;                 // stable id, used for dependency refs
  type: "image" | "video" | "music" | "3d";
  targetFilename: string;     // deterministic; the code references this path
  prompt: string;             // pre-written generation prompt
  settings: Record<string, unknown>;  // pipeline config (steps, res, duration…)
  refAssetId?: string;        // 3d: which image asset to use as reference
  status: "pending" | "done" | "placeholder" | "failed";
}
```

Validation rules:

- Every `refAssetId` must point to an earlier `image` asset (so image group runs
  before 3D group).
- Every `targetFilename` referenced in code must exist in the manifest and vice
  versa (Phase C cross-check).

---

## Hardware / model profiles

Start with this machine; structure so other systems slot in later.

**Profile `rtx-4080s-16gb`** — Ryzen 9 9950X · 64 GB RAM · RTX 4080 Super 16 GB:

| Stage                  | Model                                   | VRAM    | Notes                             |
| ---------------------- | --------------------------------------- | ------- | --------------------------------- |
| LLM (plan/code/verify) | last-loaded engine model, same settings | ~5–9 GB | must be multimodal                |
| image / 3D-ref         | **Z Image Turbo**                       | small   | distilled/turbo                   |
| 3D mesh                | **TripoSR**                             | light   | image→3D                          |
| video                  | **LTX Video**                           | ~light  |                                   |
| music                  | **ACE-Step 1.5 XL Turbo**               | 12 GB   | always solo                       |
| audio TTS / transcribe | **DISABLED in this flow**               | —       | do not route from Media AI screen |

Single-resident + 12 GB ACE-Step ceiling confirms every stage fits 16 GB alone.
Config lives in a profile map keyed by GPU/VRAM; selection is automatic by detected
hardware, with `rtx-4080s-16gb` as the first concrete entry.

---

## Autopilot phase modes

Autopilot stops being the conductor and becomes a **phase worker** with mode-specific
instruction sets injected by the orchestrator:

- **`plan-code`** — produce plan + placeholder code + manifest. **Media/asset tools
  disabled** (it must declare assets in the manifest, never generate them).
- **`verify-fix`** — integrate assets, build, **visual-verify via multimodal vision**,
  fix code, request bounded asset regen, test, deploy.

Mode boundaries are exactly the LLM-resident windows, so the orchestrator can unload
the LLM cleanly between them.

---

## Implementation phases (work breakdown)

> Design only here — no code until this plan is approved.

1. **Manifest schema + types** — `AssetManifest` / `AssetSpec` Zod schemas; where they
   live (extend `src/ipc/types/intent.ts` or new `manifest.ts`); persistence.
2. **Phase orchestrator (conductor)** — new module (likely `src/main/flow/pipeline_orchestrator.ts`)
   owning the A→B→C sequence, retries, and the single-slot invariant.
3. **Generalize `model_orchestrator.ts`** — `enterPhase`/`exitPhase`, N-kind resident,
   kill per-asset LLM reload; wire `model_lease.ts` hooks to real load/unload as the
   single-slot enforcer.
4. **Batch media generation** — rework media capabilities to consume the manifest,
   generate sequentially per modality, write to deterministic `targetFilename`,
   preserve placeholder-on-failure resilience.
5. **Hardware/model profile map** — new config (`rtx-4080s-16gb` first), auto-select
   by detected GPU/VRAM; repoint `generate_audio`→music/ACE-Step, disable TTS/STT here.
6. **Autopilot phase modes** — `plan-code` / `verify-fix` instruction sets + tool gating.
7. **Visual verification** — render/preview → screenshot → multimodal LLM compare vs
   plan → defect list → bounded fix/regen loop.
8. **End-to-end autonomous run** — one prompt → finished product; final-only user touch.

---

## Open items / risks

- **Backend load/unload control**: confirm the media backend (`:8000`) exposes
  explicit per-model load/unload so the orchestrator can guarantee single residency
  across the LLM-server and media-backend processes. (Verify before Phase 3 work.)
- **Render-for-screenshot in Phase C**: which surface produces the screenshot
  (headless preview vs. dev server) and how it is fed to the multimodal LLM.
- **Regen loop bounds**: cap retries per asset; define give-up = keep placeholder +
  flag in final report.
- **Z Image Turbo / LTX / ACE-Step**: confirm each is actually installed/served by
  the current media backend or note the install step.

```

```
