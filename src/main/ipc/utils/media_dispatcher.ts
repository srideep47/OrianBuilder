import log from "electron-log";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getOrchestrator,
  pickBestImageTier,
  pickBestAudioTtsTier,
  type MediaGenerationRequest,
  type MediaGenerationResult,
  type MediaTier,
} from "./model_orchestrator";
import { generateImageViaCloud } from "./cloud_image_generator";
import { generateImageViaLocalBackend } from "./local_image_generator";
import { getAvailableVramMb } from "./vram_accounting";
import { getCachedHardwareProfile } from "@/main/hardware/detect";
import { getLastLlmParams, estimateFreedLlmVramMb } from "./model_orchestrator";

const logger = log.scope("media-dispatcher");

/** 1×1 transparent PNG used as last-resort placeholder when no provider
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
    switch (request.modelType) {
      case "image":
        return pickBestImageTier(projected, request.preferredQuality);
      case "audio":
        return pickBestAudioTtsTier(projected, request.preferredQuality);
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
  const tier = await pickTierForRequest(request);
  if (tier) {
    logger.info(
      `tier-selected ${request.modelType}: ${tier.id} (${tier.quality})`,
    );
  }

  switch (request.modelType) {
    case "image": {
      // Provider order: local Python backend -> cloud -> placeholder.
      // The local backend is preferred because it respects the chosen tier
      // and doesn't require an API key. It silently returns success:false
      // when the Python server isn't running, so we can chain cleanly.
      const local = await generateImageViaLocalBackend(
        request.prompt,
        request.outputPath,
        { tier: tier?.id ?? null },
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
    case "audio":
    case "video":
    case "music":
      return {
        success: false,
        outputPath: request.outputPath,
        durationMs: 0,
        error: `${request.modelType} generation requires media backend (Phase 2 install)`,
      };
  }
}

let initialized = false;

/** Registers the dispatcher as the orchestrator's media provider. Safe to
 *  call multiple times — only registers once. */
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
