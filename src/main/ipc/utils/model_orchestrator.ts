import log from "electron-log";
import fs from "node:fs/promises";
import path from "node:path";
import {
  IMAGE_MODEL_TIERS as SHARED_IMAGE_TIERS,
  AUDIO_TTS_TIERS as SHARED_AUDIO_TIERS,
  AUDIO_STT_TIERS as SHARED_AUDIO_STT_TIERS,
  VIDEO_TIERS as SHARED_VIDEO_TIERS,
  pickBestTier as sharedPickBestTier,
  pickBestImageTier as sharedPickBestImage,
  pickBestAudioTtsTier as sharedPickBestAudio,
  pickBestAudioSttTier as sharedPickBestAudioStt,
  pickBestVideoTier as sharedPickBestVideo,
  selectAvailableTiers as sharedSelectAvailableTiers,
  type MediaQuality as SharedMediaQuality,
  type MediaTier as SharedMediaTier,
  type AvailableTiersSnapshot as SharedAvailableTiersSnapshot,
} from "@/shared/media_tiers";

const logger = log.scope("orchestrator");

// ─── Types (mirrored in src/ipc/types/model_orchestrator.ts for IPC) ─────────

export type OrchestratorState =
  | "idle"
  | "llm-loading"
  | "llm-loaded"
  | "swapping-out"
  | "media-loading"
  | "media-loaded"
  | "swapping-back";

export interface LlmLoadParams {
  modelPath: string;
  gpuLayers: number;
  contextSize: number;
  /** Optional model geometry used by estimateFreedLlmVramMb. When present
   *  the estimator returns a real (weights + KV cache) figure instead of
   *  the 250 MB/layer fallback. */
  modelSizeMb?: number;
  totalLayers?: number;
  /** Fraction of file size that ends up in VRAM after load. ~0.82 for Q4,
   *  ~0.95 for Q8, ~1.0 for F16. Defaults to 0.85 when omitted. */
  quantFactor?: number;
  /** Bytes per token per layer for the KV cache. */
  kvBytesPerTokenPerLayer?: number;
}

export type MediaQuality = SharedMediaQuality;

export interface MediaGenerationRequest {
  modelType: "image" | "audio" | "video" | "music" | "transcribe";
  prompt: string;
  outputPath: string;
  options?: Record<string, unknown>;
  /** Cap selected tier to this quality or lower. The floor tier ("slow")
   *  is always reachable, so passing "good" never disables CPU fallback. */
  preferredQuality?: MediaQuality;
  /** Explicit tier id to use, bypassing automatic VRAM-based tier selection.
   *  Set by the Orion Factory when the user has chosen a model for the modality. */
  modelId?: string;
}

export interface MediaGenerationResult {
  success: boolean;
  outputPath: string;
  durationMs: number;
  error?: string;
}

export interface OrchestratorStatus {
  state: OrchestratorState;
  currentLlmModel: string | null;
  currentMediaModel: string | null;
  lastSwapDurationMs: number | null;
}

export interface ModelOrchestrator {
  acquireLlm(params: LlmLoadParams): Promise<void>;
  runMediaGeneration(
    request: MediaGenerationRequest,
  ): Promise<MediaGenerationResult>;
  releaseAll(): Promise<void>;
  getStatus(): OrchestratorStatus;
}

/** Pluggable hooks so the orchestrator can swap real implementations in
 *  later phases without re-architecting. Defaults are no-ops/stubs. */
export interface OrchestratorHooks {
  /** Called when the orchestrator wants the LLM unloaded from VRAM. */
  unloadLlm?: () => Promise<void>;
  /** Called when the orchestrator wants the LLM reloaded with previous params. */
  reloadLlm?: (params: LlmLoadParams) => Promise<void>;
  /** Actually performs media generation. If not set, runMediaGeneration writes
   *  a 1×1 PNG placeholder to the requested outputPath (Phase 1 stub). */
  mediaProvider?: (
    request: MediaGenerationRequest,
  ) => Promise<MediaGenerationResult>;
}

// ─── State machine transition table ──────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<OrchestratorState, OrchestratorState[]> = {
  idle: ["llm-loading"],
  "llm-loading": ["llm-loaded", "idle"],
  "llm-loaded": ["swapping-out", "idle"],
  "swapping-out": ["media-loading", "idle"],
  "media-loading": ["media-loaded", "idle"],
  "media-loaded": ["swapping-back", "idle"],
  "swapping-back": ["llm-loaded", "idle"],
};

/** Pure helper exported for tests. Returns true iff the transition is valid. */
export function canTransition(
  from: OrchestratorState,
  to: OrchestratorState,
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

// ─── Pure planner ────────────────────────────────────────────────────────────

const SAFETY_HEADROOM_MB = 512;

/**
 * Compute the GPU layer count and context size for a given model and GPU.
 * Pure function — exported for unit tests.
 */
export function calculateOptimalLlmParams(opts: {
  modelPath?: string;
  modelSizeGb: number;
  gpuVramMb: number;
  desiredContextTokens?: number;
  totalGpuLayers: number;
}): LlmLoadParams {
  const effectiveVram = Math.max(0, opts.gpuVramMb - SAFETY_HEADROOM_MB);
  const layerSizeMb =
    opts.totalGpuLayers > 0
      ? (opts.modelSizeGb * 1024) / opts.totalGpuLayers
      : 1;
  const rawLayers =
    layerSizeMb > 0 ? Math.floor((effectiveVram * 0.85) / layerSizeMb) : 0;
  const gpuLayers = Math.max(
    0,
    Math.min(opts.totalGpuLayers, isFinite(rawLayers) ? rawLayers : 0),
  );
  const contextSize = Math.max(512, opts.desiredContextTokens ?? 4096);
  return {
    modelPath: opts.modelPath ?? "",
    gpuLayers,
    contextSize,
  };
}

// ─── Stub media generator (Phase 1 placeholder) ─────────────────────────────

/** Minimal 1×1 PNG (transparent) used as Phase 1 stub output. */
const STUB_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function writeStubMedia(
  request: MediaGenerationRequest,
): Promise<MediaGenerationResult> {
  const started = Date.now();
  try {
    await fs.mkdir(path.dirname(request.outputPath), { recursive: true });
    await fs.writeFile(request.outputPath, STUB_PNG_BYTES);
    return {
      success: true,
      outputPath: request.outputPath,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      success: false,
      outputPath: request.outputPath,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Orchestrator implementation ─────────────────────────────────────────────

class OrchestratorImpl implements ModelOrchestrator {
  private state: OrchestratorState = "idle";
  private currentLlmModel: string | null = null;
  private currentMediaModel: string | null = null;
  private lastSwapDurationMs: number | null = null;
  private lastLlmParams: LlmLoadParams | null = null;
  private hooks: OrchestratorHooks = {};

  setHooks(hooks: OrchestratorHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  getStatus(): OrchestratorStatus {
    return {
      state: this.state,
      currentLlmModel: this.currentLlmModel,
      currentMediaModel: this.currentMediaModel,
      lastSwapDurationMs: this.lastSwapDurationMs,
    };
  }

  /** Read-only access for tier-selection helpers. */
  getLastLlmParams(): LlmLoadParams | null {
    return this.lastLlmParams;
  }

  /** Inform the orchestrator that an LLM was loaded outside its control
   *  (e.g. the embedded inference server's existing load path). Updates
   *  bookkeeping without invoking the reloadLlm hook. Idempotent. */
  informLlmAcquired(params: LlmLoadParams): void {
    this.currentLlmModel = params.modelPath;
    this.lastLlmParams = params;
    if (this.state === "idle") this.state = "llm-loaded";
    else if (this.state === "llm-loading") this.state = "llm-loaded";
  }

  /** Inform the orchestrator that the LLM was unloaded outside its control.
   *  Resets state to idle without invoking the unloadLlm hook. */
  informLlmReleased(): void {
    this.currentLlmModel = null;
    this.lastLlmParams = null;
    this.state = "idle";
  }

  /** Strict transition: throws on invalid moves. */
  private transition(to: OrchestratorState): void {
    if (!canTransition(this.state, to)) {
      throw new Error(
        `Invalid orchestrator transition: ${this.state} -> ${to}`,
      );
    }
    logger.debug(`state: ${this.state} -> ${to}`);
    this.state = to;
  }

  async acquireLlm(params: LlmLoadParams): Promise<void> {
    if (this.state !== "idle" && this.state !== "llm-loaded") {
      throw new Error(
        `acquireLlm called in state ${this.state}; expected idle or llm-loaded`,
      );
    }
    // Re-acquiring same model is a no-op
    if (
      this.state === "llm-loaded" &&
      this.lastLlmParams?.modelPath === params.modelPath
    ) {
      this.lastLlmParams = params;
      return;
    }
    // If we were already loaded with a different model, release first.
    if (this.state === "llm-loaded") {
      await this.releaseAll();
    }
    this.transition("llm-loading");
    try {
      // Actual loading is delegated to the embedded inference server; the
      // hook is optional so callers can drive load externally and just inform
      // the orchestrator. We update bookkeeping either way.
      if (this.hooks.reloadLlm) {
        await this.hooks.reloadLlm(params);
      }
      this.currentLlmModel = params.modelPath;
      this.lastLlmParams = params;
      // The reloadLlm hook may itself advance state to "llm-loaded" (e.g. the
      // embedded handler's loadModelFromConfig calls informLlmAcquired). Only
      // transition if the hook didn't already, to avoid an llm-loaded ->
      // llm-loaded invalid transition.
      if (this.state !== "llm-loaded") {
        this.transition("llm-loaded");
      }
    } catch (err) {
      this.transition("idle");
      throw err;
    }
  }

  async runMediaGeneration(
    request: MediaGenerationRequest,
  ): Promise<MediaGenerationResult> {
    if (this.state !== "llm-loaded") {
      throw new Error(
        `runMediaGeneration called in state ${this.state}; expected llm-loaded`,
      );
    }
    const captured: MediaGenerationRequest = { ...request };
    const swapStarted = Date.now();

    this.transition("swapping-out");
    try {
      if (this.hooks.unloadLlm) await this.hooks.unloadLlm();
    } catch (err) {
      logger.error("unloadLlm hook failed:", err);
    }
    this.transition("media-loading");

    let result: MediaGenerationResult;
    try {
      this.currentMediaModel = `stub:${captured.modelType}`;
      this.transition("media-loaded");
      result = this.hooks.mediaProvider
        ? await this.hooks.mediaProvider(captured)
        : await writeStubMedia(captured);
    } catch (err) {
      result = {
        success: false,
        outputPath: captured.outputPath,
        durationMs: Date.now() - swapStarted,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Swap back regardless of generation success
    try {
      this.transition("swapping-back");
      this.currentMediaModel = null;
      if (this.lastLlmParams && this.hooks.reloadLlm) {
        try {
          await this.hooks.reloadLlm(this.lastLlmParams);
        } catch (err) {
          logger.error("reloadLlm hook failed:", err);
        }
      }
      this.transition("llm-loaded");
    } catch (err) {
      logger.error("swap-back transition failed:", err);
      this.state = "idle";
    }

    this.lastSwapDurationMs = Date.now() - swapStarted;
    return result;
  }

  async releaseAll(): Promise<void> {
    if (this.state === "idle") return;
    try {
      if (this.hooks.unloadLlm) await this.hooks.unloadLlm();
    } catch (err) {
      logger.error("releaseAll unload failed:", err);
    }
    this.state = "idle";
    this.currentLlmModel = null;
    this.currentMediaModel = null;
  }
}

// ─── Singleton accessors ─────────────────────────────────────────────────────

let singleton: OrchestratorImpl | null = null;

export function getOrchestrator(): OrchestratorImpl {
  if (!singleton) singleton = new OrchestratorImpl();
  return singleton;
}

/** Test-only: reset the singleton so each test starts with a clean state. */
export function _resetOrchestratorForTests(): void {
  singleton = null;
}

// ─── Phase 3: tier selection (re-exports from shared/media_tiers.ts) ─────────

export type MediaTier = SharedMediaTier;
export const IMAGE_MODEL_TIERS = SHARED_IMAGE_TIERS;
export const AUDIO_TTS_TIERS = SHARED_AUDIO_TIERS;
export const AUDIO_STT_TIERS = SHARED_AUDIO_STT_TIERS;
export const VIDEO_TIERS = SHARED_VIDEO_TIERS;
export const pickBestTier = sharedPickBestTier;
export const pickBestImageTier = sharedPickBestImage;
export const pickBestAudioTtsTier = sharedPickBestAudio;
export const pickBestAudioSttTier = sharedPickBestAudioStt;
export const pickBestVideoTier = sharedPickBestVideo;

/** Estimate VRAM (in MB) that will be freed when the currently loaded LLM is
 *  unloaded. Conservative — uses the larger of (gpuLayers × layerSize) or
 *  (model file size × 0.85). For Phase 3 we use a flat ~250 MB per layer
 *  estimate as a default until we wire real model geometry through. */
/**
 * Estimates the VRAM (in MB) that will be freed when the currently loaded
 * LLM is unloaded. When the params carry geometry (modelSizeMb +
 * totalLayers + kvBytesPerTokenPerLayer) we return a real figure:
 *   weights = modelSizeMb × quantFactor × (gpuLayers / totalLayers)
 *   kv      = contextSize × kvBytesPerTokenPerLayer × gpuLayers / MiB
 * Otherwise falls back to a flat 250 MB/layer heuristic.
 *
 * Pure function — exported for unit tests.
 */
export function estimateFreedLlmVramMb(params: LlmLoadParams | null): number {
  if (!params) return 0;
  if (params.gpuLayers <= 0) return 0;

  const hasGeometry =
    typeof params.modelSizeMb === "number" &&
    params.modelSizeMb > 0 &&
    typeof params.totalLayers === "number" &&
    params.totalLayers > 0;

  if (!hasGeometry) {
    const PER_LAYER_MB_FALLBACK = 250;
    return params.gpuLayers * PER_LAYER_MB_FALLBACK;
  }

  const modelSizeMb = params.modelSizeMb!;
  const totalLayers = params.totalLayers!;
  const quantFactor = params.quantFactor ?? 0.85;
  const offloadFraction = Math.min(params.gpuLayers, totalLayers) / totalLayers;

  // Weights actually resident in VRAM for the offloaded layers.
  const weightsMb = modelSizeMb * quantFactor * offloadFraction;

  // KV cache scales with context size × per-layer cost × offloaded layers.
  let kvMb = 0;
  if (
    typeof params.kvBytesPerTokenPerLayer === "number" &&
    params.kvBytesPerTokenPerLayer > 0
  ) {
    const kvBytes =
      params.contextSize *
      params.kvBytesPerTokenPerLayer *
      Math.min(params.gpuLayers, totalLayers);
    kvMb = kvBytes / (1024 * 1024);
  }

  return Math.round(weightsMb + kvMb);
}

export type AvailableTiersSnapshot = SharedAvailableTiersSnapshot;
export const selectAvailableTiers = sharedSelectAvailableTiers;

/** Read the current orchestrator's last loaded LLM params, if any. */
export function getLastLlmParams(): LlmLoadParams | null {
  return singleton?.getLastLlmParams() ?? null;
}
