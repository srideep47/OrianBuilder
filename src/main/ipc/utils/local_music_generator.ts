import log from "electron-log";
import { isMediaAiBackendHealthy } from "@/ipc/utils/media_ai_backend";
import {
  downloadBackendFile,
  runBackendMediaJob,
  type MediaJobProgress,
} from "./media_backend_jobs";

const logger = log.scope("local-music-gen");

export interface LocalMusicGenResult {
  success: boolean;
  outputPath: string;
  durationMs: number;
  tier?: string;
  error?: string;
}

export interface LocalMusicGenOptions {
  tier?: string | null;
  duration_s?: number;
  onProgress?: (p: MediaJobProgress) => void;
}

const MUSIC_JOB_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Generates a music track via the local backend's ACE-Step pipeline through
 * the async job API. Downloads the resulting WAV to outputPath. Never throws —
 * returns success:false on any failure (e.g. the music runtime/weights aren't
 * installed yet), letting callers degrade gracefully.
 */
export async function generateMusicViaLocalBackend(
  prompt: string,
  outputPath: string,
  options: LocalMusicGenOptions = {},
): Promise<LocalMusicGenResult> {
  const started = Date.now();

  if (!(await isMediaAiBackendHealthy())) {
    return {
      success: false,
      outputPath,
      durationMs: Date.now() - started,
      error: "local media backend not running",
    };
  }

  try {
    const result = await runBackendMediaJob(
      "music",
      {
        prompt,
        duration_seconds: options.duration_s,
        tier: options.tier ?? undefined,
      },
      { onProgress: options.onProgress, timeoutMs: MUSIC_JOB_TIMEOUT_MS },
    );
    const url = result.audio_url as string | undefined;
    if (!url) {
      return {
        success: false,
        outputPath,
        durationMs: Date.now() - started,
        error: "backend returned no audio_url",
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
    logger.warn("local music gen failed:", err);
    return {
      success: false,
      outputPath,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
