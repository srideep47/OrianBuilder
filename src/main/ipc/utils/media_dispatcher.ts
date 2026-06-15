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

const logger = log.scope("media-dispatcher");

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
  // An explicit modelId (Orion Factory user selection) wins over automatic
  // VRAM-based tier selection; only `tier.id` is needed downstream. The
  // "auto" sentinel means "no explicit choice" — fall through to selection.
  let tierId: string | null;
  if (request.modelId && request.modelId !== AUTO_TIER_ID) {
    tierId = request.modelId;
    logger.info(
      `tier-selected ${request.modelType}: ${tierId} (user-selected)`,
    );
  } else {
    const tier = await pickTierForRequest(request);
    tierId = tier?.id ?? null;
    if (tier) {
      logger.info(
        `tier-selected ${request.modelType}: ${tier.id} (${tier.quality})`,
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
        { ...request.options, tier: tierId, onProgress: request.onProgress },
      );
      if (local.success) {
        logger.info(`local image gen succeeded (tier=${local.tier ?? "?"})`);
        return local;
      }
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
        { ...request.options, tier: tierId, onProgress: request.onProgress },
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
        { ...request.options, tier: tierId, onProgress: request.onProgress },
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
        { ...request.options, tier: tierId, onProgress: request.onProgress },
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
export function dispatchMediaGeneration(
  request: MediaGenerationRequest,
): Promise<MediaGenerationResult> {
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
