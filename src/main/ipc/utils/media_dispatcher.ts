import log from "electron-log";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUTO_TIER_ID } from "@/shared/orion_media_catalog";
import {
  getOrchestrator,
  pickBestImageTier,
  pickBestAudioTtsTier,
  pickBestMusicTier,
  pickBestVideoTier,
  type MediaGenerationRequest,
  type MediaGenerationResult,
  type MediaTier,
} from "./model_orchestrator";
import { generateImageViaCloud } from "./cloud_image_generator";
import { generateImageViaLocalBackend } from "./local_image_generator";
import { generateAudioViaLocalBackend } from "./local_audio_generator";
import { generateMusicViaLocalBackend } from "./local_music_generator";
import { generateVideoViaLocalBackend } from "./local_video_generator";
import { getAvailableVramMb } from "./vram_accounting";
import { getCachedHardwareProfile } from "@/main/hardware/detect";
import { getLastLlmParams, estimateFreedLlmVramMb } from "./model_orchestrator";
import type { MediaAiModelId } from "@/ipc/types/media_ai";
import {
  downloadMediaAiModels,
  getMediaAiBackendStatus,
} from "@/ipc/utils/media_ai_backend";
import { ensureLlmSwapForMedia } from "./media_llm_guard";

const logger = log.scope("media-dispatcher");

type DispatchableModelType = "image" | "audio" | "music" | "video";

/** The Media AI status API records downloadable *weight groups*, while
 * generation uses individual tier ids. Keep that translation here so every
 * caller (chat, factory pipeline, and direct media requests) gets identical
 * fallback behavior. */
const TIER_DOWNLOAD_IDS: Partial<Record<string, MediaAiModelId>> = {
  "z-image-turbo": "image-z-image-turbo",
  "sd-turbo": "image-sd-turbo",
  "speecht5-cpu": "audio",
};

function downloadIdForTier(
  modelType: DispatchableModelType,
  tierId: string | null,
): MediaAiModelId | undefined {
  if (tierId && TIER_DOWNLOAD_IDS[tierId]) return TIER_DOWNLOAD_IDS[tierId];
  // A video marker represents the machine-matched tier selected by the
  // downloader. Reverting to auto lets the backend reuse that same tier.
  if (modelType === "video") return "video";
  return undefined;
}

/**
 * Pick an installed compatible tier before downloading anything. If no known
 * tier is installed, use the hardware-selected tier rather than forcing a
 * user-selected model that may not fit the current device.
 *
 * Exported as a pure function so fallback ordering stays regression-testable.
 */
export function resolveAvailableMediaTier(args: {
  modelType: DispatchableModelType;
  preferredTierId: string | null;
  hardwareTierId: string | null;
  downloadedModelIds: ReadonlySet<string>;
}): { tierId: string | null; downloadId?: MediaAiModelId; reason: string } {
  const { modelType, preferredTierId, hardwareTierId, downloadedModelIds } =
    args;

  // The video status marker is intentionally hardware-specific rather than
  // tier-specific: the downloader resolves the best tier for this machine.
  // Never force a possibly different saved tier over those downloaded weights.
  if (modelType === "video" && downloadedModelIds.has("video")) {
    return {
      tierId: hardwareTierId,
      reason:
        hardwareTierId === preferredTierId
          ? "requested tier is installed"
          : "installed alternative",
    };
  }
  const candidates = [preferredTierId, hardwareTierId];

  // Image tiers are the only ones with per-tier download markers today. When
  // the requested/highest-quality tier is absent, SD Turbo is a compatible,
  // much smaller installed alternative. Prefer it over a new download.
  if (modelType === "image") {
    candidates.push("z-image-turbo", "sd-turbo");
  } else if (modelType === "audio") {
    candidates.push("speecht5-cpu");
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || candidate === AUTO_TIER_ID || seen.has(candidate))
      continue;
    seen.add(candidate);
    const downloadId = downloadIdForTier(modelType, candidate);
    if (downloadId && downloadedModelIds.has(downloadId)) {
      return {
        tierId: candidate,
        reason:
          candidate === preferredTierId
            ? "requested tier is installed"
            : "installed alternative",
      };
    }
  }

  // No tracked alternative exists. Let automatic tiers stay automatic so the
  // backend can apply its complete VRAM/RAM checks; otherwise install the
  // hardware-selected concrete tier.
  const tierId = hardwareTierId ?? preferredTierId;
  const downloadId = downloadIdForTier(modelType, tierId);
  return {
    tierId,
    downloadId:
      downloadId && !downloadedModelIds.has(downloadId)
        ? downloadId
        : undefined,
    reason: "best tier for this hardware",
  };
}

/** 1x1 transparent PNG used as last-resort placeholder when no provider
 *  can satisfy a request. */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function writePlaceholder(
  request: MediaGenerationRequest,
): Promise<MediaGenerationResult> {
  const started = Date.now();
  await fs.mkdir(path.dirname(request.outputPath), { recursive: true });
  await fs.writeFile(request.outputPath, PLACEHOLDER_PNG);
  return {
    success: true,
    outputPath: request.outputPath,
    durationMs: Date.now() - started,
    error: "placeholder (no real provider available)",
  };
}

async function pickTierForRequest(
  request: MediaGenerationRequest,
): Promise<MediaTier | null> {
  try {
    const profile = await getCachedHardwareProfile();
    const live = await getAvailableVramMb(profile);
    const projected = live + estimateFreedLlmVramMb(getLastLlmParams());
    // Video tiers are RAM-gated too (LTX-2 trades VRAM for system RAM via
    // offload) — pass total RAM so selection matches the Python backend's.
    const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));
    switch (request.modelType) {
      case "image":
        return pickBestImageTier(projected, request.preferredQuality);
      case "audio":
        return pickBestAudioTtsTier(projected, request.preferredQuality);
      case "music":
        return pickBestMusicTier(projected, request.preferredQuality);
      case "video":
        // Pass whether a keyframe accompanies the request so image-to-video
        // tiers (Wan 2.2 14B) become eligible — without this they're always
        // filtered out and a storyboard clip with a keyframe still gets an
        // LTX text-to-video tier forced onto the backend.
        return pickBestVideoTier(
          projected,
          request.preferredQuality,
          totalRamMb,
          Boolean(
            (request.options as { image_path?: unknown } | undefined)
              ?.image_path,
          ),
        );
      default:
        return null;
    }
  } catch (err) {
    logger.warn("tier selection failed:", err);
    return null;
  }
}

async function dispatch(
  request: MediaGenerationRequest,
): Promise<MediaGenerationResult> {
  const cancelledResult = (): MediaGenerationResult => ({
    success: false,
    outputPath: request.outputPath,
    durationMs: 0,
    error: `${request.modelType} generation was cancelled`,
  });
  if (request.signal?.aborted) return cancelledResult();
  // Always compute the hardware tier, even when the user selected a model.
  // It is the safe download target when neither the selection nor an
  // alternative is installed on this machine.
  const hardwareTier = await pickTierForRequest(request);
  const preferredTierId =
    request.modelId && request.modelId !== AUTO_TIER_ID
      ? request.modelId
      : (hardwareTier?.id ?? null);
  let tierId = preferredTierId;

  if (request.modelType !== "transcribe") {
    try {
      const status = await getMediaAiBackendStatus();
      const downloadedModelIds = new Set(
        status.models
          .filter((model) => model.downloaded)
          .map((model) => model.id),
      );
      const resolution = resolveAvailableMediaTier({
        modelType: request.modelType,
        preferredTierId,
        hardwareTierId: hardwareTier?.id ?? null,
        downloadedModelIds,
      });
      tierId = resolution.tierId;

      if (resolution.downloadId) {
        request.onProgress?.({
          stage: `Downloading ${resolution.downloadId}`,
          progress: null,
        });
        logger.info(
          `downloading ${resolution.downloadId} for ${request.modelType} (${resolution.reason})`,
        );
        await downloadMediaAiModels([resolution.downloadId], (chunk) => {
          const progress = /"percentage"\s*:\s*([0-9.]+)/.exec(chunk)?.[1];
          request.onProgress?.({
            stage: `Downloading ${resolution.downloadId}`,
            progress: progress ? Number(progress) / 100 : null,
          });
        });
      }

      logger.info(
        `tier-selected ${request.modelType}: ${tierId ?? "auto"} (${resolution.reason})`,
      );
    } catch (err) {
      // Model preparation should not suppress provider/cloud fallbacks. The
      // backend can still resolve first-use downloads if a pre-download fails.
      logger.warn(
        `model availability check failed for ${request.modelType}; continuing with ${tierId ?? "auto"}:`,
        err,
      );
    }
  }

  switch (request.modelType) {
    case "image": {
      // Provider order: local Python backend -> cloud -> placeholder.
      // The local backend is preferred because it respects the chosen tier
      // and doesn't require an API key. It silently returns success:false
      // when the Python server isn't running, so we can chain cleanly.
      // Caller-supplied options (size, steps, …) ride along with the tier so
      // requests like "9:16 portrait" actually reach the backend.
      const local = await generateImageViaLocalBackend(
        request.prompt,
        request.outputPath,
        {
          ...request.options,
          tier: tierId,
          onProgress: request.onProgress,
          signal: request.signal,
        },
      );
      if (local.success) {
        logger.info(`local image gen succeeded (tier=${local.tier ?? "?"})`);
        return local;
      }
      if (request.signal?.aborted) return cancelledResult();
      logger.info(
        `local image gen unavailable (${local.error ?? "unknown"}); trying cloud`,
      );

      const cloud = await generateImageViaCloud(
        request.prompt,
        request.outputPath,
      );
      if (cloud.success) return cloud;
      logger.warn(
        `image generation fell back to placeholder: ${cloud.error ?? "unknown"}`,
      );
      return writePlaceholder(request);
    }
    case "music": {
      // Music goes to the ACE-Step pipeline. (It used to be mis-routed to the
      // TTS endpoint, which read the prompt aloud instead of composing.)
      const music = await generateMusicViaLocalBackend(
        request.prompt,
        request.outputPath,
        {
          ...request.options,
          tier: tierId,
          onProgress: request.onProgress,
          signal: request.signal,
        },
      );
      if (music.success) {
        logger.info(`local music gen succeeded (tier=${music.tier ?? "?"})`);
        return music;
      }
      return {
        success: false,
        outputPath: request.outputPath,
        durationMs: music.durationMs,
        error: music.error ?? "music generation failed",
      };
    }
    case "audio": {
      const audio = await generateAudioViaLocalBackend(
        request.prompt,
        request.outputPath,
        {
          ...request.options,
          tier: tierId,
          onProgress: request.onProgress,
          signal: request.signal,
        },
      );
      if (audio.success) {
        logger.info(`local audio gen succeeded (tier=${audio.tier ?? "?"})`);
        return audio;
      }
      return {
        success: false,
        outputPath: request.outputPath,
        durationMs: audio.durationMs,
        error: audio.error ?? "audio generation failed",
      };
    }
    case "video": {
      const video = await generateVideoViaLocalBackend(
        request.prompt,
        request.outputPath,
        {
          ...request.options,
          tier: tierId,
          onProgress: request.onProgress,
          signal: request.signal,
        },
      );
      if (video.success) {
        logger.info(`local video gen succeeded (tier=${video.tier ?? "?"})`);
        return video;
      }
      return {
        success: false,
        outputPath: request.outputPath,
        durationMs: video.durationMs,
        error: video.error ?? "video generation failed",
      };
    }
    case "transcribe": {
      // Transcription is request/response (no media generation), surfaced via
      // its own IPC path. The orchestrator's runMedia channel is for content
      // creation only; if a caller routes a transcribe request here it's a bug.
      return {
        success: false,
        outputPath: request.outputPath,
        durationMs: 0,
        error:
          "transcribe is not handled by media dispatcher; use the dedicated transcribe IPC route",
      };
    }
  }
}

/**
 * Run a media generation request through the real provider chain directly,
 * without going through the orchestrator's LLM swap. Used by the flow layer
 * when no embedded LLM is loaded (so there is nothing to swap out). When an
 * LLM *is* loaded, callers should use `orchestrator.runMediaGeneration` instead
 * so the LLM is unloaded/reloaded around generation.
 */
export async function dispatchMediaGeneration(
  request: MediaGenerationRequest,
): Promise<MediaGenerationResult> {
  initMediaDispatcher();
  if (ensureLlmSwapForMedia()) {
    return getOrchestrator().runMediaGeneration(request);
  }
  return dispatch(request);
}

let initialized = false;

/** Registers the dispatcher as the orchestrator's media provider. Safe to
 *  call multiple times; only registers once. */
export function initMediaDispatcher(): void {
  if (initialized) return;
  getOrchestrator().setHooks({ mediaProvider: dispatch });
  initialized = true;
  logger.info("media dispatcher registered with orchestrator");
}

/** Test-only: clears the initialized flag. */
export function _resetMediaDispatcherForTests(): void {
  initialized = false;
}
