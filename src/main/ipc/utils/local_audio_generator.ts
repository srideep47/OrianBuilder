import log from "electron-log";
import { isMediaAiBackendHealthy } from "@/ipc/utils/media_ai_backend";
import {
  downloadBackendFile,
  runBackendMediaJob,
  type MediaJobProgress,
} from "./media_backend_jobs";

const logger = log.scope("local-audio-gen");

export interface LocalAudioGenResult {
  success: boolean;
  outputPath: string;
  durationMs: number;
  tier?: string;
  error?: string;
}

export interface LocalAudioGenOptions {
  voice?: string;
  tier?: string | null;
  onProgress?: (p: MediaJobProgress) => void;
}

/** First TTS run may download model weights; generation itself is quick. */
const TTS_JOB_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Generates speech via the local Python media backend's async job API.
 * Downloads the resulting WAV to outputPath. Never throws — returns
 * success:false on any failure.
 */
export async function generateAudioViaLocalBackend(
  text: string,
  outputPath: string,
  options: LocalAudioGenOptions = {},
): Promise<LocalAudioGenResult> {
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
      "tts",
      { text, voice: options.voice, tier: options.tier ?? undefined },
      { onProgress: options.onProgress, timeoutMs: TTS_JOB_TIMEOUT_MS },
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
    logger.warn("local audio gen failed:", err);
    return {
      success: false,
      outputPath,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
