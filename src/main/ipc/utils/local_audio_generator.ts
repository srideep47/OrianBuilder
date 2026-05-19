import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import {
  MEDIA_AI_SERVER_URL,
  isMediaAiBackendHealthy,
} from "@/ipc/utils/media_ai_backend";

const logger = log.scope("local-audio-gen");

export interface LocalAudioGenResult {
  success: boolean;
  outputPath: string;
  durationMs: number;
  tier?: string;
  error?: string;
}

/**
 * Generates speech via the local Python media backend's
 * `POST /v1/generate/audio/tts` endpoint. Downloads the resulting WAV
 * to outputPath. Never throws — returns success:false on any failure.
 */
export async function generateAudioViaLocalBackend(
  text: string,
  outputPath: string,
  options: { voice?: string; tier?: string | null } = {},
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
    const response = await fetch(
      `${MEDIA_AI_SERVER_URL}/v1/generate/audio/tts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, ...options }),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        success: false,
        outputPath,
        durationMs: Date.now() - started,
        error: `backend ${response.status}: ${detail.slice(0, 200)}`,
      };
    }
    const data = (await response.json()) as {
      audio_url: string;
      tier?: string;
    };
    if (!data.audio_url) {
      return {
        success: false,
        outputPath,
        durationMs: Date.now() - started,
        error: "backend returned no audio_url",
      };
    }
    const fileResponse = await fetch(`${MEDIA_AI_SERVER_URL}${data.audio_url}`);
    if (!fileResponse.ok) {
      return {
        success: false,
        outputPath,
        durationMs: Date.now() - started,
        error: `fetch of generated audio failed: ${fileResponse.status}`,
      };
    }
    const buf = Buffer.from(await fileResponse.arrayBuffer());
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, buf);
    return {
      success: true,
      outputPath,
      durationMs: Date.now() - started,
      tier: data.tier,
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
