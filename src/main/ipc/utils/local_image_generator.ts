import log from "electron-log";
import { isMediaAiBackendHealthy } from "@/ipc/utils/media_ai_backend";
import {
  downloadBackendFile,
  runBackendMediaJob,
  type MediaJobProgress,
} from "./media_backend_jobs";

const logger = log.scope("local-image-gen");

export interface LocalImageGenResult {
  success: boolean;
  outputPath: string;
  durationMs: number;
  tier?: string;
  error?: string;
}

export interface LocalImageGenOptions {
  steps?: number;
  guidance?: number;
  width?: number;
  height?: number;
  tier?: string | null;
  /** Fixed RNG seed. Storyboards pass one stable seed for every keyframe so the
   *  scenes share a consistent visual style instead of drifting between
   *  realistic / anime / 3D looks on each independent generation. */
  seed?: number;
  onProgress?: (p: MediaJobProgress) => void;
}

/** Generation is fast; the budget covers a first-run multi-GB weight fetch. */
const IMAGE_JOB_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Generates an image via the local Python media backend's async job API
 * (submit + poll, immune to long first-run model downloads). The backend
 * writes the file to OMNIGEN_OUTPUTS_DIR; we fetch it and copy the bytes to
 * `outputPath`.
 *
 * Returns success:false (never throws) so callers can fall back to other
 * providers cleanly.
 */
export async function generateImageViaLocalBackend(
  prompt: string,
  outputPath: string,
  options: LocalImageGenOptions = {},
): Promise<LocalImageGenResult> {
  const started = Date.now();

  // Probe health first so we fail fast if the backend isn't running.
  if (!(await isMediaAiBackendHealthy())) {
    return {
      success: false,
      outputPath,
      durationMs: Date.now() - started,
      error: "local media backend not running",
    };
  }

  const { onProgress, ...params } = options;
  try {
    const result = await runBackendMediaJob(
      "image",
      { prompt, ...params },
      { onProgress, timeoutMs: IMAGE_JOB_TIMEOUT_MS },
    );
    const url = result.image_url as string | undefined;
    if (!url) {
      return {
        success: false,
        outputPath,
        durationMs: Date.now() - started,
        error: "backend returned no image_url",
      };
    }
    await downloadBackendFile(url, outputPath);
    return {
      success: true,
      outputPath,
      durationMs: Date.now() - started,
      tier: result.tier as string | undefined,
    };
  } catch (err) {
    logger.warn("local image gen failed:", err);
    return {
      success: false,
      outputPath,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
