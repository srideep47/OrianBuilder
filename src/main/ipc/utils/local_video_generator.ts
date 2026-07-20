import log from "electron-log";
import { isMediaAiBackendHealthy } from "@/ipc/utils/media_ai_backend";
import {
  downloadBackendFile,
  runBackendMediaJob,
  type MediaJobProgress,
} from "./media_backend_jobs";

const logger = log.scope("local-video-gen");

export interface LocalVideoGenResult {
  success: boolean;
  outputPath: string;
  durationMs: number;
  tier?: string;
  model?: string;
  /** True when the mp4 already carries a synced soundtrack (AV tiers). */
  hasAudio?: boolean;
  error?: string;
}

export interface LocalVideoGenOptions {
  tier?: string | null;
  num_frames?: number;
  fps?: number;
  width?: number;
  height?: number;
  steps?: number;
  duration_s?: number;
  /** "16:9" | "9:16" | … — sizes the clip to the tier's pixel budget when
   *  width/height are omitted. */
  aspect_ratio?: string;
  /** Absolute path to a keyframe image — routes i2v-capable tiers (Wan 2.2
   *  14B requires one; LTX tiers use it when given) into image-to-video. */
  image_path?: string;
  /** Fixed RNG seed — storyboards pass one stable seed across all clips so the
   *  motion/look stays consistent scene to scene. */
  seed?: number;
  negative_prompt?: string;
  onProgress?: (p: MediaJobProgress) => void;
  signal?: AbortSignal;
}

/** Video gen can include a multi-GB first-run model download plus minutes of
 *  inference on low-end GPUs — budget generously; polls keep it responsive. */
const VIDEO_JOB_TIMEOUT_MS = 90 * 60 * 1000;

/**
 * Generates a short video via the local Python media backend's async job API
 * (submit + poll — a single synchronous request would be killed by undici's
 * 300 s header timeout long before slow hardware finishes). Downloads the
 * resulting file to outputPath. Never throws — returns success:false on any
 * failure.
 */
export async function generateVideoViaLocalBackend(
  prompt: string,
  outputPath: string,
  options: LocalVideoGenOptions = {},
): Promise<LocalVideoGenResult> {
  const started = Date.now();

  if (!(await isMediaAiBackendHealthy())) {
    return {
      success: false,
      outputPath,
      durationMs: Date.now() - started,
      error: "local media backend not running",
    };
  }

  const { onProgress, signal, ...params } = options;
  try {
    const result = await runBackendMediaJob(
      "video",
      { prompt, ...params },
      { onProgress, signal, timeoutMs: VIDEO_JOB_TIMEOUT_MS },
    );
    const url = result.video_url as string | undefined;
    if (!url) {
      return {
        success: false,
        outputPath,
        durationMs: Date.now() - started,
        error: "backend returned no video_url",
      };
    }
    await downloadBackendFile(url, outputPath);
    return {
      success: true,
      outputPath,
      durationMs: Date.now() - started,
      tier: result.tier as string | undefined,
      model: result.model as string | undefined,
      hasAudio: result.has_audio === true,
    };
  } catch (err) {
    logger.warn("local video gen failed:", err);
    return {
      success: false,
      outputPath,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
