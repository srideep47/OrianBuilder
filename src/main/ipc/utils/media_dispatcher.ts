import log from "electron-log";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getOrchestrator,
  type MediaGenerationRequest,
  type MediaGenerationResult,
} from "./model_orchestrator";
import { generateImageViaCloud } from "./cloud_image_generator";

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

async function dispatch(
  request: MediaGenerationRequest,
): Promise<MediaGenerationResult> {
  switch (request.modelType) {
    case "image": {
      const cloud = await generateImageViaCloud(
        request.prompt,
        request.outputPath,
      );
      if (cloud.success) return cloud;
      // Phase 1: real local image generation lands in Phase 2.
      // For now, return placeholder so state machine still completes.
      logger.warn(
        `image generation fell back to placeholder: ${cloud.error ?? "unknown"}`,
      );
      return writePlaceholder(request);
    }
    case "audio":
    case "video":
    case "music":
      // Real audio/video/music providers land in Phase 2.
      return {
        success: false,
        outputPath: request.outputPath,
        durationMs: 0,
        error: `${request.modelType} generation not yet supported in this phase`,
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
