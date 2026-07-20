import log from "electron-log";
import {
  groupAssetsByModality,
  validateManifest,
  type AssetManifest,
  type AssetSpec,
  type AssetStatus,
} from "@/ipc/types/manifest";
import {
  modelConfigForAsset,
  type HardwareModelProfile,
} from "./model_profiles";
import type { ModelGate, ResidentSlot } from "./model_gate";
import {
  compileMediaGraph,
  mediaGraphFromAssetManifest,
  type OrionMediaGraph,
} from "@/shared/orion_media_graph";

// =============================================================================
// Orion Orchestrated Pipeline — Conductor
// =============================================================================
//
// Owns the fixed phase sequence and the single-resident invariant:
//
//   PHASE A  plan-code   (LLM resident)  → produces the asset manifest
//   PHASE B  assets      (LLM unloaded)  → batch by modality, one pipeline at a
//                                          time, sequential within a batch
//   PHASE C  verify-fix  (LLM resident)  → integrate, build, vision-verify, fix;
//                                          may request bounded asset regen → B
//
// The conductor sequences phases, drives the ModelGate (enter/exit), runs the
// regen loop, and aggregates status. The actual work (LLM calls, asset backends,
// visual verification) lives behind injected WORKERS so this module stays free
// of Electron/DB/backend specifics and fully unit-testable.
// See plans/orion-orchestrated-pipeline.md.
// =============================================================================

const logger = log.scope("pipeline");

// ─── Worker contracts (injected; wired to real backends in later checkpoints) ─

export interface PlanCodeArgs {
  buildId: string;
  goal: string;
  appId?: number;
  appPath?: string;
}

/** Phase A worker: scaffolds code with placeholders and returns the manifest. */
export type PlanCodeWorker = (args: PlanCodeArgs) => Promise<AssetManifest>;

export interface GenerateAssetArgs {
  asset: AssetSpec;
  profile: HardwareModelProfile;
  mediaDir: string;
  /** Absolute path of the resolved reference image (3D assets), if any. */
  refImagePath?: string;
}

export interface AssetGenResult {
  status: Extract<AssetStatus, "done" | "placeholder" | "failed">;
  /** Absolute path the asset was written to (done/placeholder). */
  outputPath?: string;
  error?: string;
}

/** Phase B worker: generates ONE asset. The gate is already on its modality. */
export type GenerateAssetWorker = (
  args: GenerateAssetArgs,
) => Promise<AssetGenResult>;

export interface PrepareModelArgs {
  buildId: string;
  type: AssetSpec["type"];
  slot: ResidentSlot;
}

export interface ModelPreparationResult {
  status: "ok" | "partial";
  detail: string;
}

/** Prepare only the model needed by the next planned modality batch. This is
 *  intentionally called after planning and immediately before gate.with(). */
export type PrepareModelWorker = (
  args: PrepareModelArgs,
) => Promise<ModelPreparationResult>;

export interface VerifyFixArgs {
  buildId: string;
  goal: string;
  manifest: AssetManifest;
  appId?: number;
  appPath?: string;
  /** 1-based pass number (for bounded retries). */
  attempt: number;
}

export interface VerifyResult {
  /** True when the build is verified good and the pipeline can finish. */
  ok: boolean;
  /** Asset ids the verifier wants regenerated before another pass. */
  regenAssetIds?: string[];
  /** Human-readable summary for the final report. */
  report?: string;
}

/** Phase C worker: integrate + build + visual-verify + fix. LLM resident. */
export type VerifyFixWorker = (args: VerifyFixArgs) => Promise<VerifyResult>;

export interface PipelineWorkers {
  planCode: PlanCodeWorker;
  prepareModel?: PrepareModelWorker;
  generateAsset: GenerateAssetWorker;
  verifyFix: VerifyFixWorker;
}

/** A single live progress update emitted as the pipeline advances. */
export interface PipelineProgressEvent {
  buildId: string;
  kind: "download" | "phase" | "asset" | "info";
  label: string;
  detail?: string;
  status?: "running" | "ok" | "failed" | "partial";
}

export type PipelineProgressFn = (event: PipelineProgressEvent) => void;

/** Map an asset status to a coarse progress status. */
function assetProgressStatus(
  status: AssetStatus,
): "running" | "ok" | "failed" | "partial" {
  if (status === "done") return "ok";
  if (status === "placeholder") return "partial";
  if (status === "failed") return "failed";
  return "running";
}

// ─── Pipeline config + result ─────────────────────────────────────────────────

export interface PipelineConfig {
  goal: string;
  appId?: number;
  appPath?: string;
  mediaDir: string;
  profile: HardwareModelProfile;
  gate: ModelGate;
  workers: PipelineWorkers;
  /** Identifier for the engine's last-loaded LLM (for gate no-op detection). */
  llmModelId?: string;
  /** LLM single-slot footprint (MB) for gate bookkeeping. */
  llmVramMb?: number;
  /** Max verify→regen passes before giving up. Default 3. */
  maxVerifyAttempts?: number;
  /** Optional live progress sink (streamed to the renderer's activity feed). */
  onProgress?: PipelineProgressFn;
}

export type PipelinePhase = "download" | "plan-code" | "assets" | "verify";
export type PipelineStatus = "completed" | "partial" | "failed";

export interface PhaseRecord {
  phase: PipelinePhase;
  status: "ok" | "partial" | "failed";
  detail: string;
}

export interface PipelineResult {
  buildId: string;
  status: PipelineStatus;
  manifest: AssetManifest;
  /** Versioned executor-neutral graph used for this run. */
  mediaGraph?: OrionMediaGraph;
  phases: PhaseRecord[];
  verifyAttempts: number;
  assetSummary: { done: number; placeholder: number; failed: number };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function llmSlot(config: PipelineConfig): ResidentSlot {
  return {
    kind: "llm",
    modelId: config.llmModelId ?? "llm",
    vramMb: config.llmVramMb ?? 8000,
  };
}

function modalitySlot(
  profile: HardwareModelProfile,
  type: AssetSpec["type"],
): ResidentSlot {
  const cfg = modelConfigForAsset(profile, type);
  const kind = type === "3d" ? "3d" : type;
  return { kind, modelId: cfg.modelId, vramMb: cfg.vramMb };
}

function summarize(assets: AssetSpec[]): {
  done: number;
  placeholder: number;
  failed: number;
} {
  let done = 0;
  let placeholder = 0;
  let failed = 0;
  for (const a of assets) {
    if (a.status === "done") done++;
    else if (a.status === "placeholder") placeholder++;
    else if (a.status === "failed") failed++;
  }
  return { done, placeholder, failed };
}

/** Generate one modality batch sequentially. Mutates each asset's status and
 *  records output paths into `outputPaths`. Never throws — per-asset failures
 *  become "failed"/"placeholder" so the build is not blocked. */
async function runModalityBatch(
  type: AssetSpec["type"],
  assets: AssetSpec[],
  config: PipelineConfig,
  outputPaths: Map<string, string>,
  buildId: string,
): Promise<ModelPreparationResult | undefined> {
  const slot = modalitySlot(config.profile, type);
  let preparation: ModelPreparationResult | undefined;
  if (config.workers.prepareModel) {
    config.onProgress?.({
      buildId,
      kind: "download",
      label: `Preparing ${type} model`,
      detail: slot.modelId,
      status: "running",
    });
    try {
      preparation = await config.workers.prepareModel({ buildId, type, slot });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      preparation = { status: "partial", detail };
      logger.warn(`model preparation for ${type} failed: ${detail}`);
    }
    config.onProgress?.({
      buildId,
      kind: "download",
      label:
        preparation.status === "ok"
          ? `${type} model ready`
          : `${type} model preparation incomplete`,
      detail: preparation.detail,
      status: preparation.status,
    });
  }
  // Hold residency for the complete batch so another flow cannot swap models
  // between two assets of the same modality.
  await config.gate.with(slot, async () => {
    for (const asset of assets) {
      config.onProgress?.({
        buildId,
        kind: "asset",
        label: `${type}: ${asset.id}`,
        detail: `generating with ${slot.modelId}`,
        status: "running",
      });
      const refImagePath =
        asset.refAssetId != null
          ? outputPaths.get(asset.refAssetId)
          : undefined;
      try {
        const res = await config.workers.generateAsset({
          asset,
          profile: config.profile,
          mediaDir: config.mediaDir,
          refImagePath,
        });
        asset.status = res.status;
        if (res.outputPath) outputPaths.set(asset.id, res.outputPath);
        logger.info(`asset ${asset.id} (${type}) → ${res.status}`);
        config.onProgress?.({
          buildId,
          kind: "asset",
          label: `${type}: ${asset.id}`,
          detail: res.error ? `${res.status} — ${res.error}` : res.status,
          status: assetProgressStatus(res.status),
        });
      } catch (err) {
        asset.status = "failed";
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`asset ${asset.id} (${type}) threw: ${message}`);
        config.onProgress?.({
          buildId,
          kind: "asset",
          label: `${type}: ${asset.id}`,
          detail: `failed — ${message}`,
          status: "failed",
        });
      }
    }
  });
  return preparation;
}

/** Run Phase B over the given asset list, batched + ordered by modality. */
async function runAssetPhase(
  assets: AssetSpec[],
  config: PipelineConfig,
  outputPaths: Map<string, string>,
  buildId: string,
): Promise<ModelPreparationResult[]> {
  const groups = groupAssetsByModality({ buildId: "", assets });
  const preparations: ModelPreparationResult[] = [];
  for (const group of groups) {
    const preparation = await runModalityBatch(
      group.type,
      group.assets,
      config,
      outputPaths,
      buildId,
    );
    if (preparation) preparations.push(preparation);
  }
  // Leave Phase B with nothing resident so Phase A/C LLM load is unobstructed.
  await config.gate.exit();
  return preparations;
}

// ─── Conductor ───────────────────────────────────────────────────────────────

/**
 * Run the full autonomous pipeline for one prompt: plan-code → assets →
 * verify-fix (with bounded asset regen). Returns a structured result; only the
 * unrecoverable case (Phase A produced no usable manifest) yields "failed".
 */
export async function runPipeline(
  config: PipelineConfig,
): Promise<PipelineResult> {
  const buildId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `build-${Date.now()}`;
  const maxAttempts = config.maxVerifyAttempts ?? 3;
  const phases: PhaseRecord[] = [];
  const outputPaths = new Map<string, string>();
  const report = config.onProgress;
  logger.info(`pipeline ${buildId} start: "${config.goal}"`);

  // ── PHASE A — plan & code (LLM resident) ──
  report?.({
    buildId,
    kind: "phase",
    label: "Planning & writing the asset manifest",
    detail: "language model resident",
    status: "running",
  });
  let manifest: AssetManifest;
  try {
    manifest = await config.gate.with(llmSlot(config), () =>
      config.workers.planCode({
        buildId,
        goal: config.goal,
        appId: config.appId,
        appPath: config.appPath,
      }),
    );
  } catch (err) {
    await config.gate.exit().catch(() => {});
    const detail = err instanceof Error ? err.message : String(err);
    logger.error(`pipeline ${buildId} plan-code failed: ${detail}`);
    report?.({
      buildId,
      kind: "phase",
      label: "Planning failed",
      detail,
      status: "failed",
    });
    return {
      buildId,
      status: "failed",
      manifest: { buildId, assets: [] },
      phases: [{ phase: "plan-code", status: "failed", detail }],
      verifyAttempts: 0,
      assetSummary: { done: 0, placeholder: 0, failed: 0 },
    };
  }

  const manifestValidation = validateManifest(manifest);
  const mediaGraph = mediaGraphFromAssetManifest(manifest);
  const graphPlan = compileMediaGraph(mediaGraph);
  const validationErrors = [
    ...manifestValidation.errors,
    ...graphPlan.errors.filter(
      (error) => !manifestValidation.errors.includes(error),
    ),
  ];
  const planIsValid = manifestValidation.ok && graphPlan.ok;
  if (!planIsValid) {
    // A malformed manifest is a planning bug, but we still try to build with
    // whatever assets are structurally usable rather than aborting outright.
    logger.warn(
      `pipeline ${buildId} media plan validation issues: ${validationErrors.join("; ")}`,
    );
  }
  phases.push({
    phase: "plan-code",
    status: planIsValid ? "ok" : "partial",
    detail: planIsValid
      ? `media graph v${mediaGraph.version} with ${manifest.assets.length} assets in ${graphPlan.waves.length} dependency wave(s)`
      : `media plan issues: ${validationErrors.join("; ")}`,
  });
  report?.({
    buildId,
    kind: "phase",
    label: "Plan ready",
    detail: `${manifest.assets.length} asset(s) to generate`,
    status: planIsValid ? "ok" : "partial",
  });

  // Unload the LLM before asset generation.
  await config.gate.exit();

  // ── PHASE B — assets (LLM unloaded, batched by modality) ──
  report?.({
    buildId,
    kind: "phase",
    label: "Generating assets",
    detail: "language model unloaded; one media model resident at a time",
    status: "running",
  });
  const assetsById = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const plannedAssets = graphPlan.ok
    ? graphPlan.orderedNodeIds
        .map((id) => assetsById.get(id))
        .filter((asset): asset is AssetSpec => asset != null)
    : manifest.assets;
  const modelPreparations = await runAssetPhase(
    plannedAssets,
    config,
    outputPaths,
    buildId,
  );
  if (modelPreparations.length > 0) {
    const incomplete = modelPreparations.some(
      (item) => item.status === "partial",
    );
    phases.push({
      phase: "download",
      status: incomplete ? "partial" : "ok",
      detail: modelPreparations.map((item) => item.detail).join("; "),
    });
  }
  const afterGen = summarize(manifest.assets);
  phases.push({
    phase: "assets",
    status: afterGen.failed > 0 || afterGen.placeholder > 0 ? "partial" : "ok",
    detail: `done=${afterGen.done} placeholder=${afterGen.placeholder} failed=${afterGen.failed}`,
  });
  report?.({
    buildId,
    kind: "phase",
    label: "Assets complete",
    detail: `done=${afterGen.done} placeholder=${afterGen.placeholder} failed=${afterGen.failed}`,
    status: afterGen.failed > 0 || afterGen.placeholder > 0 ? "partial" : "ok",
  });

  // ── PHASE C — verify / fix / (bounded) regen (LLM resident) ──
  let verifyAttempts = 0;
  let lastVerify: VerifyResult = { ok: false };
  while (verifyAttempts < maxAttempts) {
    verifyAttempts++;
    report?.({
      buildId,
      kind: "phase",
      label: `Verifying${verifyAttempts > 1 ? ` (attempt ${verifyAttempts})` : ""}`,
      detail: "language model reloaded",
      status: "running",
    });
    lastVerify = await config.gate.with(llmSlot(config), () =>
      config.workers.verifyFix({
        buildId,
        goal: config.goal,
        manifest,
        appId: config.appId,
        appPath: config.appPath,
        attempt: verifyAttempts,
      }),
    );

    if (lastVerify.ok) break;

    const regenIds = (lastVerify.regenAssetIds ?? []).filter((id) =>
      manifest.assets.some((a) => a.id === id),
    );
    if (regenIds.length === 0) {
      // Verifier couldn't fix and asked for no regen → stop looping.
      break;
    }
    if (verifyAttempts >= maxAttempts) break;

    // Unload LLM, regenerate only the requested assets, then re-verify.
    await config.gate.exit();
    const regenAssets = manifest.assets.filter((a) => regenIds.includes(a.id));
    for (const a of regenAssets) a.status = "pending";
    logger.info(`pipeline ${buildId} regen pass for [${regenIds.join(", ")}]`);
    report?.({
      buildId,
      kind: "phase",
      label: "Regenerating failed assets",
      detail: regenIds.join(", "),
      status: "running",
    });
    await runAssetPhase(regenAssets, config, outputPaths, buildId);
  }
  await config.gate.exit();

  phases.push({
    phase: "verify",
    status: lastVerify.ok ? "ok" : "partial",
    detail: lastVerify.report ?? (lastVerify.ok ? "verified" : "not verified"),
  });
  report?.({
    buildId,
    kind: "phase",
    label: lastVerify.ok ? "Verified" : "Verify incomplete",
    detail: lastVerify.report ?? undefined,
    status: lastVerify.ok ? "ok" : "partial",
  });

  const finalSummary = summarize(manifest.assets);
  const status: PipelineStatus = lastVerify.ok
    ? finalSummary.failed > 0 || finalSummary.placeholder > 0
      ? "partial"
      : "completed"
    : "partial";

  logger.info(`pipeline ${buildId} done: ${status}`);
  report?.({
    buildId,
    kind: "info",
    label: `Pipeline ${status}`,
    detail: `assets done=${finalSummary.done} placeholder=${finalSummary.placeholder} failed=${finalSummary.failed}`,
    status: status === "completed" ? "ok" : "partial",
  });
  return {
    buildId,
    status,
    manifest,
    mediaGraph,
    phases,
    verifyAttempts,
    assetSummary: finalSummary,
  };
}
