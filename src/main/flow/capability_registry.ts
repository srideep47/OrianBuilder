import path from "node:path";
import crypto from "node:crypto";
import log from "electron-log";
import {
  getOrchestrator,
  type MediaGenerationRequest,
  type MediaGenerationResult,
} from "@/main/ipc/utils/model_orchestrator";
import {
  initMediaDispatcher,
  dispatchMediaGeneration,
} from "@/main/ipc/utils/media_dispatcher";
import {
  getModelLeaseManager,
  type Lease,
  type ModelSpec,
} from "@/main/flow/model_lease";
import {
  modelConfigForAsset,
  type HardwareModelProfile,
} from "@/main/flow/model_profiles";
import type { AssetType } from "@/ipc/types/manifest";
import type { CapabilityId, CapabilityDescriptor } from "@/ipc/types/intent";

const logger = log.scope("flow-capabilities");

// =============================================================================
// Flow execution context
// =============================================================================

/**
 * Context threaded through every capability execution within a single flow.
 * Resolved by the flow runner so capabilities stay free of Electron/DB imports
 * and remain unit-testable.
 */
export interface FlowContext {
  /** Restated user goal for the whole flow. */
  goal: string;
  /** Target app id, when the flow operates on an existing app. */
  appId?: number;
  /** Absolute path to the target app directory, when known. */
  appPath?: string;
  /** Absolute directory where generated media should be written. */
  mediaDir: string;
  /** Free-form constraints surfaced from the parsed intent. */
  constraints?: Record<string, unknown>;
  /** Structured outputs of already-completed steps, keyed by step id. */
  priorOutputs: Record<string, Record<string, unknown>>;
  /**
   * Device hardware/model profile (selected models + best per-stage settings).
   * When present, media capabilities use the user's chosen model per modality at
   * the device's best settings instead of automatic VRAM-based tiering. Resolved
   * by the IPC layer via `applySelectionToProfile(selectProfileForVram(...))`.
   */
  mediaProfile?: HardwareModelProfile;
}

/** A flow-level capability. Pure async function over (input, ctx). */
export interface Capability {
  readonly id: CapabilityId;
  readonly label: string;
  readonly description: string;
  execute(
    input: Record<string, unknown>,
    ctx: FlowContext,
  ): Promise<Record<string, unknown>>;
}

// =============================================================================
// Mission escalation hook (set by the IPC layer where mission code is reachable)
// =============================================================================

/**
 * Prepares an app + chat for a build and returns a handoff the renderer uses to
 * launch the proven Autopilot agent-build. Injected at registration time from
 * `flow_handlers.ts` so this module avoids a hard dependency on the DB / app
 * handlers (keeps it testable). Returns a structured handoff descriptor.
 */
export type BuildExecutor = (params: {
  goal: string;
  appId?: number;
  /** Asset/design paths produced by earlier steps the build should use. */
  mediaRefs: string[];
}) => Promise<Record<string, unknown>>;

let buildExecutor: BuildExecutor | null = null;

export function setBuildExecutor(fn: BuildExecutor | null): void {
  buildExecutor = fn;
}

/**
 * Creates a Design Studio artifact/session for a flow step. Injected by the IPC
 * layer so this registry stays free of DB and filesystem-specific imports.
 */
export type DesignExecutor = (params: {
  goal: string;
  prompt: string;
  appId?: number;
  appPath?: string;
  mediaDir: string;
}) => Promise<Record<string, unknown>>;

let designExecutor: DesignExecutor | null = null;

export function setDesignExecutor(fn: DesignExecutor | null): void {
  designExecutor = fn;
}

export type ThreeDExecutor = (params: {
  goal: string;
  prompt: string;
  imagePath?: string;
  appId?: number;
  appPath?: string;
  mediaDir: string;
}) => Promise<Record<string, unknown>>;

let threeDExecutor: ThreeDExecutor | null = null;

export function setThreeDExecutor(fn: ThreeDExecutor | null): void {
  threeDExecutor = fn;
}

export type NewsExecutor = (params: {
  goal: string;
  query: string;
  category?: string;
  mediaDir: string;
}) => Promise<Record<string, unknown>>;

let newsExecutor: NewsExecutor | null = null;

export function setNewsExecutor(fn: NewsExecutor | null): void {
  newsExecutor = fn;
}

export type TrackingExecutor = (params: {
  goal: string;
  prompt: string;
  kind: "website" | "price";
  url?: string;
  targetPrice?: number;
}) => Promise<Record<string, unknown>>;

let trackingExecutor: TrackingExecutor | null = null;

export function setTrackingExecutor(fn: TrackingExecutor | null): void {
  trackingExecutor = fn;
}

/**
 * P2P job dispatch hook (Orion network). Consulted before local generation:
 * returns `null` when the job should run locally, a success result when a
 * trusted peer generated the asset, or a failure result when the chosen peer
 * could not — in which case the local chain runs as the fallback ("requeue").
 * Injected by the IPC layer so this registry stays free of network imports.
 */
export type RemoteMediaDispatcher = (
  request: MediaGenerationRequest,
) => Promise<MediaGenerationResult | null>;

let remoteMediaDispatcher: RemoteMediaDispatcher | null = null;

export function setRemoteMediaDispatcher(
  fn: RemoteMediaDispatcher | null,
): void {
  remoteMediaDispatcher = fn;
}

// =============================================================================
// Media helpers
// =============================================================================

const CAPABILITY_MODEL_SPECS: Partial<Record<CapabilityId, ModelSpec>> = {
  generate_design: { key: "design:html", vramMb: 1024, priority: 5 },
  generate_image: { key: "media:image", vramMb: 4096, priority: 10 },
  generate_audio: { key: "media:audio", vramMb: 2048, priority: 8 },
  generate_music: { key: "media:music", vramMb: 8192, priority: 11 },
  generate_video: { key: "media:video", vramMb: 8192, priority: 12 },
  generate_3d_asset: { key: "media:3d", vramMb: 8192, priority: 12 },
  research_news: { key: "network:news", vramMb: 256, priority: 2 },
  track_website: { key: "watchdog:website", vramMb: 512, priority: 3 },
  track_price: { key: "watchdog:price", vramMb: 512, priority: 3 },
};

async function withModelLease<T>(
  spec: ModelSpec | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!spec) return run();

  const manager = getModelLeaseManager();
  let lease: Lease | null = null;
  try {
    lease = await manager.acquire(spec);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("hooks not configured") ||
      message.includes("insufficient VRAM") ||
      message.includes("Cannot fit model")
    ) {
      logger.warn(
        `model lease unavailable for ${spec.key}: ${message}; continuing with capability-level fallback`,
      );
      return run();
    }
    throw err;
  }

  if (!lease) return run();

  try {
    return await run();
  } finally {
    lease.release();
    await manager.releaseIdle().catch((err) => {
      logger.warn(`failed to release idle model leases after ${spec.key}`, err);
    });
  }
}

function reserveMediaPath(mediaDir: string, ext: string): string {
  const hash = crypto.randomBytes(6).toString("hex");
  return path.join(mediaDir, `flow-${Date.now()}-${hash}.${ext}`);
}

/**
 * Run a media request through the orchestrator (with LLM swap) when an embedded
 * LLM is loaded, otherwise straight through the provider chain. `modelId` (the
 * user-selected model) and `options` (best per-stage settings) are forwarded so
 * the dispatcher uses exactly that model instead of an automatic VRAM pick.
 */
async function runMedia(
  modelType: "image" | "audio" | "video" | "music",
  prompt: string,
  outputPath: string,
  opts?: { modelId?: string; options?: Record<string, unknown> },
): Promise<MediaGenerationResult> {
  const request: MediaGenerationRequest = {
    modelType,
    prompt,
    outputPath,
    modelId: opts?.modelId,
    options: opts?.options,
  };

  // P2P placement first: a trusted peer may be better suited (or explicitly
  // selected). A remote failure is NOT final — the job is requeued locally by
  // simply continuing into the local chain below.
  if (remoteMediaDispatcher) {
    try {
      const remote = await remoteMediaDispatcher(request);
      if (remote?.success) return remote;
      if (remote) {
        logger.warn(
          `remote ${modelType} generation failed (${remote.error ?? "unknown"}); requeueing locally`,
        );
      }
    } catch (err) {
      logger.warn(
        `remote ${modelType} dispatch threw; requeueing locally`,
        err,
      );
    }
  }

  initMediaDispatcher();
  const orch = getOrchestrator();
  if (orch.getStatus().state === "llm-loaded") {
    return orch.runMediaGeneration(request);
  }
  return dispatchMediaGeneration(request);
}

function requirePrompt(input: Record<string, unknown>): string {
  const prompt = input.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error("Media capability requires a non-empty 'prompt' input.");
  }
  return prompt;
}

function makeMediaCapability(
  id: Extract<
    CapabilityId,
    "generate_image" | "generate_audio" | "generate_music" | "generate_video"
  >,
  /** Modality used to look up the selected model + best settings in the profile. */
  assetType: AssetType,
  modelType: "image" | "audio" | "video" | "music",
  ext: string,
  label: string,
  description: string,
): Capability {
  return {
    id,
    label,
    description,
    async execute(input, ctx) {
      const prompt = requirePrompt(input);
      const outputPath = reserveMediaPath(ctx.mediaDir, ext);
      // When a hardware profile is threaded in (Orion media generation), use the
      // user's selected model for this modality at the device's best settings —
      // mirroring asset_worker.ts. Otherwise fall back to automatic VRAM tiering.
      const stageCfg = ctx.mediaProfile
        ? modelConfigForAsset(ctx.mediaProfile, assetType)
        : undefined;
      logger.info(
        `[${id}] generating -> ${outputPath}` +
          (stageCfg ? ` (model=${stageCfg.modelId})` : " (auto tier)"),
      );
      const result = await withModelLease(CAPABILITY_MODEL_SPECS[id], () =>
        runMedia(modelType, prompt, outputPath, {
          modelId: stageCfg?.modelId,
          options: stageCfg?.defaultSettings,
        }),
      );
      if (!result.success) {
        if (
          modelType === "audio" ||
          modelType === "music" ||
          modelType === "video"
        ) {
          return {
            setupRequired: true,
            setupRoute: "/mediaai",
            reason: result.error ?? `${id} backend unavailable`,
            modelType,
            prompt,
            plannedOutputPath: outputPath,
          };
        }
        throw new Error(result.error ?? `${id} failed`);
      }
      // A "placeholder" success means NO real provider produced the asset (a 1×1
      // PNG was written as a last resort). Surface it as needs-setup so the UI
      // shows a clear message instead of rendering a blank image.
      if ((result.error ?? "").toLowerCase().includes("placeholder")) {
        return {
          setupRequired: true,
          setupRoute: "/mediaai",
          reason:
            "No media model produced output — make sure the Media AI backend is running and the selected model is downloaded.",
          modelType,
          prompt,
          plannedOutputPath: result.outputPath,
        };
      }
      return {
        outputPath: result.outputPath,
        durationMs: result.durationMs,
        modelType,
      };
    },
  };
}

// =============================================================================
// Capability instances
// =============================================================================

const generateDesignCapability: Capability = {
  id: "generate_design",
  label: "Generate design",
  description:
    "Create a Design Studio HTML artifact/session that downstream build steps can implement.",
  async execute(input, ctx) {
    const prompt =
      typeof input.prompt === "string" && input.prompt.trim()
        ? input.prompt.trim()
        : ctx.goal;

    const executor = designExecutor;
    if (!executor) {
      logger.warn(
        "generate_design invoked but no design executor is registered; returning handoff descriptor.",
      );
      return {
        runDesign: false,
        reason: "design-executor-not-registered",
        prompt,
      };
    }

    return withModelLease(CAPABILITY_MODEL_SPECS.generate_design, () =>
      executor({
        goal: ctx.goal,
        prompt,
        appId: ctx.appId,
        appPath: ctx.appPath,
        mediaDir: ctx.mediaDir,
      }),
    );
  },
};

const generateImageCapability = makeMediaCapability(
  "generate_image",
  "image",
  "image",
  "png",
  "Generate image",
  "Generate an image from a text prompt using the selected image model at best settings (local-first, cloud fallback).",
);

const generateAudioCapability = makeMediaCapability(
  "generate_audio",
  "speech",
  "audio",
  "wav",
  "Generate speech",
  "Generate spoken audio/narration from text using the selected speech (TTS) model.",
);

const generateMusicCapability = makeMediaCapability(
  "generate_music",
  "music",
  "music",
  "wav",
  "Generate music",
  "Generate music or a song from a text prompt using the selected music model.",
);

const generateVideoCapability = makeMediaCapability(
  "generate_video",
  "video",
  "video",
  "mp4",
  "Generate video",
  "Generate a short video from a text prompt using the selected video model.",
);

function firstPriorOutputPath(ctx: FlowContext): string | undefined {
  for (const output of Object.values(ctx.priorOutputs)) {
    const p = output.outputPath;
    if (typeof p === "string" && p.trim()) return p;
  }
  return undefined;
}

const generate3dAssetCapability: Capability = {
  id: "generate_3d_asset",
  label: "Generate 3D asset",
  description:
    "Generate a 3D GLB asset from a generated or supplied reference image via the 3D asset workflow.",
  async execute(input, ctx) {
    const prompt =
      typeof input.prompt === "string" && input.prompt.trim()
        ? input.prompt.trim()
        : ctx.goal;
    const imagePath =
      typeof input.imagePath === "string" && input.imagePath.trim()
        ? input.imagePath.trim()
        : firstPriorOutputPath(ctx);

    const executor = threeDExecutor;
    if (!executor) {
      logger.warn(
        "generate_3d_asset invoked but no 3D executor is registered; returning handoff descriptor.",
      );
      return {
        run3d: false,
        reason: "three-d-executor-not-registered",
        prompt,
        imagePath,
      };
    }

    return withModelLease(CAPABILITY_MODEL_SPECS.generate_3d_asset, () =>
      executor({
        goal: ctx.goal,
        prompt,
        imagePath,
        appId: ctx.appId,
        appPath: ctx.appPath,
        mediaDir: ctx.mediaDir,
      }),
    );
  },
};

const researchNewsCapability: Capability = {
  id: "research_news",
  label: "Research news",
  description:
    "Fetch current Daily AI Digest news/headlines for the requested topic or category.",
  async execute(input, ctx) {
    const query =
      typeof input.query === "string" && input.query.trim()
        ? input.query.trim()
        : typeof input.prompt === "string" && input.prompt.trim()
          ? input.prompt.trim()
          : ctx.goal;
    const category =
      typeof input.category === "string" && input.category.trim()
        ? input.category.trim()
        : undefined;

    const executor = newsExecutor;
    if (!executor) {
      logger.warn(
        "research_news invoked but no news executor is registered; returning handoff descriptor.",
      );
      return { runNews: false, reason: "news-executor-not-registered", query };
    }

    return withModelLease(CAPABILITY_MODEL_SPECS.research_news, () =>
      executor({ goal: ctx.goal, query, category, mediaDir: ctx.mediaDir }),
    );
  },
};

function getInputNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function makeTrackingCapability(
  id: Extract<CapabilityId, "track_website" | "track_price">,
  kind: "website" | "price",
  label: string,
  description: string,
): Capability {
  return {
    id,
    label,
    description,
    async execute(input, ctx) {
      const prompt =
        typeof input.prompt === "string" && input.prompt.trim()
          ? input.prompt.trim()
          : ctx.goal;
      const url =
        typeof input.url === "string" && input.url.trim()
          ? input.url.trim()
          : undefined;
      const targetPrice = getInputNumber(input, "targetPrice");

      const executor = trackingExecutor;
      if (!executor) {
        logger.warn(
          `${id} invoked but no tracking executor is registered; returning handoff descriptor.`,
        );
        return {
          runTracking: false,
          reason: "tracking-executor-not-registered",
          prompt,
          kind,
          url,
        };
      }

      return withModelLease(CAPABILITY_MODEL_SPECS[id], () =>
        executor({ goal: ctx.goal, prompt, kind, url, targetPrice }),
      );
    },
  };
}

const trackWebsiteCapability = makeTrackingCapability(
  "track_website",
  "website",
  "Track website",
  "Add a site to Watchdog and check it for content/news changes.",
);

const trackPriceCapability = makeTrackingCapability(
  "track_price",
  "price",
  "Track price",
  "Add a product URL to Watchdog price monitoring.",
);

const buildAppCapability: Capability = {
  id: "build_app",
  label: "Build app",
  description:
    "Build or modify an application end-to-end via the autonomous Autopilot agent.",
  async execute(input, ctx) {
    const goal =
      typeof input.goal === "string" && input.goal.trim()
        ? (input.goal as string)
        : ctx.goal;

    // Collect assets produced by earlier steps so the build can reference them.
    const mediaRefs: string[] = [];
    for (const output of Object.values(ctx.priorOutputs)) {
      const paths = [output.outputPath, output.artifactPath];
      for (const p of paths) {
        if (typeof p === "string") mediaRefs.push(p);
      }
      const designSessionId = output.designSessionId;
      if (typeof designSessionId === "number") {
        mediaRefs.push(`Design Studio session ${designSessionId}`);
      }
    }

    if (!buildExecutor) {
      logger.warn(
        "build_app invoked but no build executor is registered; returning handoff descriptor.",
      );
      return { runBuild: false, reason: "build-executor-not-registered", goal };
    }

    return buildExecutor({ goal, appId: ctx.appId, mediaRefs });
  },
};

// =============================================================================
// Registry
// =============================================================================

const CAPABILITIES: Record<CapabilityId, Capability> = {
  generate_design: generateDesignCapability,
  generate_image: generateImageCapability,
  generate_audio: generateAudioCapability,
  generate_music: generateMusicCapability,
  generate_video: generateVideoCapability,
  generate_3d_asset: generate3dAssetCapability,
  research_news: researchNewsCapability,
  track_website: trackWebsiteCapability,
  track_price: trackPriceCapability,
  build_app: buildAppCapability,
};

export function getCapability(id: CapabilityId): Capability {
  return CAPABILITIES[id];
}

export function listCapabilities(): CapabilityDescriptor[] {
  return Object.values(CAPABILITIES).map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
  }));
}
