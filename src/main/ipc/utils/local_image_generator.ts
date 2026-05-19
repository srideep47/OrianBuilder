import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import {
  MEDIA_AI_SERVER_URL,
  isMediaAiBackendHealthy,
} from "@/ipc/utils/media_ai_backend";

const logger = log.scope("local-image-gen");

export interface LocalImageGenResult {
  success: boolean;
  outputPath: string;
  durationMs: number;
  tier?: string;
  error?: string;
}

interface ImageRequestBody {
  prompt: string;
  steps?: number;
  guidance?: number;
  width?: number;
  height?: number;
  tier?: string | null;
}

/**
 * Generates an image via the local Python media backend's
 * `POST /v1/generate/image` endpoint. The backend writes the file to
 * OMNIGEN_OUTPUTS_DIR and returns a relative URL. We then fetch the URL
 * and copy the bytes to `outputPath`.
 *
 * Returns success:false (never throws) so callers can fall back to other
 * providers cleanly.
 */
export async function generateImageViaLocalBackend(
  prompt: string,
  outputPath: string,
  options: Pick<
    ImageRequestBody,
    "steps" | "guidance" | "width" | "height" | "tier"
  > = {},
): Promise<LocalImageGenResult> {
  const started = Date.now();

  // Probe health first so we fail fast if the backend isn't running.
  const healthy = await isMediaAiBackendHealthy();
  if (!healthy) {
    return {
      success: false,
      outputPath,
      durationMs: Date.now() - started,
      error: "local media backend not running",
    };
  }

  try {
    const response = await fetch(`${MEDIA_AI_SERVER_URL}/v1/generate/image`, {
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
      image_url: string;
      tier?: string;
    };
    if (!data.image_url) {
      return {
        success: false,
        outputPath,
        durationMs: Date.now() - started,
        error: "backend returned no image_url",
      };
    }

    // image_url is server-relative (e.g. /outputs/v1-abc.png). Resolve and fetch.
    const fileResponse = await fetch(`${MEDIA_AI_SERVER_URL}${data.image_url}`);
    if (!fileResponse.ok) {
      return {
        success: false,
        outputPath,
        durationMs: Date.now() - started,
        error: `fetch of generated image failed: ${fileResponse.status}`,
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
    logger.warn("local image gen failed:", err);
    return {
      success: false,
      outputPath,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
