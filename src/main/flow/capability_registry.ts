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
import { getModelGate, type ResidentSlot } from "@/main/flow/model_gate";
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
  /** Live progress for the currently executing media step. */
  onMediaProgress?: (p: { stage: string; progress: number | null }) => void;
  /** Cancels long-running local/remote provider work for this flow. */
  signal?: AbortSignal;
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

const DEFAULT_MEDIA_VRAM_MB: Record<AssetType, number> = {
  image: 4096,
  speech: 2048,
  music: 8192,
  video: 8192,
  "3d": 8192,
};

function mediaResidentSlot(
  assetType: AssetType,
  config?: { modelId: string; vramMb: number },
): ResidentSlot {
  return {
    kind: assetType,
    modelId: config?.modelId ?? `${assetType}:auto`,
    vramMb: config?.vramMb ?? DEFAULT_MEDIA_VRAM_MB[assetType],
  };
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
  opts?: {
    modelId?: string;
    options?: Record<string, unknown>;
    onProgress?: (p: { stage: string; progress: number | null }) => void;
    signal?: AbortSignal;
  },
): Promise<MediaGenerationResult> {
  const request: MediaGenerationRequest = {
    modelType,
    prompt,
    outputPath,
    modelId: opts?.modelId,
    options: opts?.options,
    onProgress: opts?.onProgress,
    signal: opts?.signal,
  };

  if (request.signal?.aborted) {
    return {
      success: false,
      outputPath,
      durationMs: 0,
      error: `${modelType} generation was cancelled`,
    };
  }

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
      const mediaConstraint =
        ctx.constraints?.media &&
        typeof ctx.constraints.media === "object" &&
        !Array.isArray(ctx.constraints.media)
          ? (ctx.constraints.media as Record<string, unknown>)
          : undefined;
      const constraintOptions =
        mediaConstraint?.options &&
        typeof mediaConstraint.options === "object" &&
        !Array.isArray(mediaConstraint.options)
          ? (mediaConstraint.options as Record<string, unknown>)
          : {};
      const inputOptions =
        input.options &&
        typeof input.options === "object" &&
        !Array.isArray(input.options)
          ? (input.options as Record<string, unknown>)
          : {};
      const requestedModel =
        typeof mediaConstraint?.modelId === "string" &&
        mediaConstraint.modelId !== "auto"
          ? mediaConstraint.modelId
          : undefined;
      const selectedModel = requestedModel ?? stageCfg?.modelId;
      const generationOptions = {
        ...stageCfg?.defaultSettings,
        ...constraintOptions,
        ...inputOptions,
      };
      const residentConfig = selectedModel
        ? {
            modelId: selectedModel,
            vramMb: stageCfg?.vramMb ?? DEFAULT_MEDIA_VRAM_MB[assetType],
          }
        : undefined;
      logger.info(
        `[${id}] generating -> ${outputPath}` +
          (selectedModel ? ` (model=${selectedModel})` : " (auto tier)"),
      );
      const result = await getModelGate().with(
        mediaResidentSlot(assetType, residentConfig),
        () =>
          runMedia(modelType, prompt, outputPath, {
            modelId: selectedModel,
            options: generationOptions,
            onProgress: ctx.onMediaProgress,
            signal: ctx.signal,
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
            setupRoute: "/media-runtime",
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
          setupRoute: "/media-runtime",
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

    return executor({
      goal: ctx.goal,
      prompt,
      appId: ctx.appId,
      appPath: ctx.appPath,
      mediaDir: ctx.mediaDir,
    });
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

    const stageCfg = ctx.mediaProfile
      ? modelConfigForAsset(ctx.mediaProfile, "3d")
      : undefined;
    return getModelGate().with(mediaResidentSlot("3d", stageCfg), () =>
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

    return executor({
      goal: ctx.goal,
      query,
      category,
      mediaDir: ctx.mediaDir,
    });
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

      return executor({ goal: ctx.goal, prompt, kind, url, targetPrice });
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

/**
 * Games are built by the same autonomous agent as apps, because that is where the
 * `godot_*`, `blender_*` and `generate_game_asset` tools live — a separate
 * executor here would either duplicate that tool loop or bypass it.
 *
 * What this capability adds is *framing*. Without it the planner reaches for
 * `build_app` and the agent scaffolds a web project, because that is what
 * "build" has always meant here. This tells it the deliverable is a playable
 * Godot project and names the tools that get it there, so the plan starts with a
 * project scaffold and ends with a screenshot rather than a dev server.
 */
const makeGameCapability: Capability = {
  id: "make_game",
  label: "Make a game",
  description:
    "Create or extend a Godot game: scaffold the project, build the scene, generate and import assets, and verify it by running the engine.",
  async execute(input, ctx) {
    const goal =
      typeof input.goal === "string" && input.goal.trim()
        ? (input.goal as string)
        : ctx.goal;

    if (!buildExecutor) {
      logger.warn(
        "make_game invoked but no build executor is registered; returning handoff descriptor.",
      );
      return { runBuild: false, reason: "build-executor-not-registered", goal };
    }

    const assetRefs: string[] = [];
    for (const output of Object.values(ctx.priorOutputs)) {
      for (const candidate of [output.outputPath, output.artifactPath]) {
        if (typeof candidate === "string") assetRefs.push(candidate);
      }
    }

    return buildExecutor({
      goal: [
        goal,
        "",
        "Deliver this as a Godot 4 game in this project.",
        "Call godot_create_project if there is no project yet, then godot_launch",
        "(headless while iterating), godot_create_node and godot_set_property to",
        "build the scene, generate_game_asset for meshes, textures, music, sound",
        "and voice, blender_* to clean up or rig any generated mesh, and",
        "godot_screenshot to look at your work before godot_save_scene.",
      ].join("\n"),
      appId: ctx.appId,
      mediaRefs: assetRefs,
    });
  },
};

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
  make_game: makeGameCapability,
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
