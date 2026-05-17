import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import {
  MEDIA_AI_SERVER_URL,
  isMediaAiBackendHealthy,
} from "@/ipc/utils/media_ai_backend";

const logger = log.scope("local-video-gen");

export interface LocalVideoGenResult {
  success: boolean;
  outputPath: string;
  durationMs: number;
  tier?: string;
  model?: string;
  error?: string;
}

export interface LocalVideoGenOptions {
  tier?: string | null;
  num_frames?: number;
  fps?: number;
  width?: number;
  height?: number;
  steps?: number;
}

/**
 * Generates a short video via the local Python media backend's
 * `POST /v1/generate/video` endpoint. Downloads the resulting file to
 * outputPath. Never throws — returns success:false on any failure.
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

  try {
    const response = await fetch(`${MEDIA_AI_SERVER_URL}/v1/generate/video`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, ...options }),
    });
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
      video_url?: string;
      tier?: string;
      model?: string;
    };
    const url = data.video_url;
    if (!url) {
      return {
        success: false,
        outputPath,
        durationMs: Date.now() - started,
        error: "backend returned no video_url",
      };
    }
    const fileResponse = await fetch(`${MEDIA_AI_SERVER_URL}${url}`);
    if (!fileResponse.ok) {
      return {
        success: false,
        outputPath,
        durationMs: Date.now() - started,
        error: `fetch of generated video failed: ${fileResponse.status}`,
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
      model: data.model,
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
