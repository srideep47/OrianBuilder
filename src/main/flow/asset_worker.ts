import path from "node:path";
import fs from "node:fs/promises";
import log from "electron-log";
import { dispatchMediaGeneration } from "@/main/ipc/utils/media_dispatcher";
import type {
  MediaGenerationRequest,
  MediaGenerationResult,
} from "@/main/ipc/utils/model_orchestrator";
import { modelConfigForAsset } from "./model_profiles";
import type {
  GenerateAssetArgs,
  GenerateAssetWorker,
  AssetGenResult,
} from "./pipeline_orchestrator";

// =============================================================================
// Orion Orchestrated Pipeline — Media Asset Worker (Phase B implementation)
// =============================================================================
//
// The concrete `GenerateAssetWorker` the conductor calls once per asset, with
// the ModelGate ALREADY on the asset's modality. It therefore goes straight to
// `dispatchMediaGeneration` (the no-LLM-swap path) — the per-asset LLM swap of
// the old orchestrator is exactly what batching replaces.
//
// Writes each asset to its deterministic `targetFilename` under `mediaDir`.
// Failures never throw: image falls back to a placeholder (dispatcher does this
// internally); video/music/3d that can't be produced return "failed" so Phase C
// can flag the gap — the build is never blocked.
//
// Built as an injectable factory so the mapping logic is unit-testable without
// touching real backends. See plans/orion-orchestrated-pipeline.md.
// =============================================================================

const logger = log.scope("asset-worker");

/** Generate a textured GLB from a reference image (TripoSR pipeline). */
export type ThreeDGenerator = (args: {
  prompt: string;
  refImagePath?: string;
  outputPath: string;
  settings: Record<string, unknown>;
}) => Promise<{ success: boolean; outputPath?: string; error?: string }>;

export interface MediaAssetWorkerDeps {
  dispatch: (req: MediaGenerationRequest) => Promise<MediaGenerationResult>;
  /** Optional 3D backend. When absent, 3D assets resolve to "failed". */
  generate3d?: ThreeDGenerator;
}

function isPlaceholderResult(result: MediaGenerationResult): boolean {
  return (result.error ?? "").toLowerCase().includes("placeholder");
}

/**
 * Build the concrete asset worker. `deps.dispatch` is the media provider chain;
 * `deps.generate3d` is the optional TripoSR-style backend.
 */
export function createMediaAssetWorker(
  deps: MediaAssetWorkerDeps,
): GenerateAssetWorker {
  return async function generateAsset(
    args: GenerateAssetArgs,
  ): Promise<AssetGenResult> {
    const { asset, profile, mediaDir, refImagePath } = args;
    const outputPath = path.join(mediaDir, asset.targetFilename);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    // Per-stage defaults (profile) under per-asset overrides (manifest).
    const stageCfg = modelConfigForAsset(profile, asset.type);
    const settings: Record<string, unknown> = {
      ...stageCfg.defaultSettings,
      ...asset.settings,
    };

    if (asset.type === "3d") {
      if (!deps.generate3d) {
        logger.warn(`3D asset ${asset.id}: no 3D backend wired`);
        return { status: "failed", error: "3d-backend-not-wired" };
      }
      const res = await deps.generate3d({
        prompt: asset.prompt,
        refImagePath,
        outputPath,
        settings,
      });
      return res.success
        ? { status: "done", outputPath: res.outputPath ?? outputPath }
        : { status: "failed", error: res.error ?? "3d generation failed" };
    }

    // "speech" assets are produced by the TTS path ("audio"); music/image/video
    // map straight through. The chosen model id (profile, user-overridden) is
    // passed so the dispatcher uses exactly that model instead of a VRAM pick.
    const modelType: "image" | "video" | "music" | "audio" =
      asset.type === "music"
        ? "music"
        : asset.type === "speech"
          ? "audio"
          : (asset.type as "image" | "video");
    const result = await deps.dispatch({
      modelType,
      prompt: asset.prompt,
      outputPath,
      options: settings,
      modelId: stageCfg.modelId,
    });

    if (result.success) {
      if (isPlaceholderResult(result)) {
        return { status: "placeholder", outputPath: result.outputPath };
      }
      return { status: "done", outputPath: result.outputPath };
    }
    return { status: "failed", error: result.error ?? `${asset.type} failed` };
  };
}

// ─── Default wiring (real dispatcher; 3D backend injected later) ─────────────

let defaultThreeD: ThreeDGenerator | undefined;

/** Register the real 3D (TripoSR) backend used by the default asset worker. */
export function setThreeDGenerator(fn: ThreeDGenerator | undefined): void {
  defaultThreeD = fn;
}

/** The asset worker wired to the real media dispatcher. */
export function defaultAssetWorker(): GenerateAssetWorker {
  return createMediaAssetWorker({
    dispatch: dispatchMediaGeneration,
    generate3d: defaultThreeD,
  });
}
