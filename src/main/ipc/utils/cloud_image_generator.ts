import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import { readSettings } from "@/main/settings";
import { ImageGenerationApiResponseSchema } from "@/ipc/types/image_generation";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";

const logger = log.scope("cloud-image-gen");
const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";

interface CloudKey {
  key: string;
  baseUrl: string;
}

export function resolveCloudImageKey(): CloudKey | null {
  const settings = readSettings();
  const proKey = settings.providerSettings?.auto?.apiKey?.value;
  if (proKey) {
    const engineUrl =
      process.env.ORIANBUILDER_ENGINE_URL ??
      "https://engine.orianbuilder.sh/v1";
    return { key: proKey, baseUrl: `${engineUrl}/images/generations` };
  }
  const openaiKey = settings.providerSettings?.openai?.apiKey?.value;
  if (openaiKey) return { key: openaiKey, baseUrl: OPENAI_IMAGE_URL };
  return null;
}

async function callCloudImageApi(prompt: string, cred: CloudKey) {
  const response = await fetch(cred.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cred.key}`,
    },
    body: JSON.stringify({
      prompt,
      model: "dall-e-3",
      n: 1,
      size: "1024x1024",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Cloud image generation failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const parsed = ImageGenerationApiResponseSchema.parse(await response.json());
  if (!parsed.data || parsed.data.length === 0) {
    throw new OrianBuilderError(
      "Cloud image generation returned no results",
      OrianBuilderErrorKind.External,
    );
  }
  return parsed.data[0];
}

async function writeImageBytes(
  data: { b64_json?: string | null; url?: string | null },
  outputPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (data.b64_json) {
    await fs.writeFile(outputPath, Buffer.from(data.b64_json, "base64"));
    return;
  }
  if (data.url) {
    const response = await fetch(data.url);
    if (!response.ok) {
      throw new OrianBuilderError(
        `Failed to download generated image: ${response.status}`,
        OrianBuilderErrorKind.External,
      );
    }
    const buf = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buf);
    return;
  }
  throw new OrianBuilderError(
    "Cloud image generation returned no image data",
    OrianBuilderErrorKind.External,
  );
}

export interface CloudImageGenResult {
  success: boolean;
  outputPath: string;
  durationMs: number;
  error?: string;
}

/** Returns a CloudImageGenResult — never throws. `success=false` means
 *  the caller should fall back to a local/stub provider. */
export async function generateImageViaCloud(
  prompt: string,
  outputPath: string,
): Promise<CloudImageGenResult> {
  const started = Date.now();
  const cred = resolveCloudImageKey();
  if (!cred) {
    return {
      success: false,
      outputPath,
      durationMs: 0,
      error: "no cloud API key configured",
    };
  }
  try {
    const data = await callCloudImageApi(prompt, cred);
    await writeImageBytes(data, outputPath);
    return { success: true, outputPath, durationMs: Date.now() - started };
  } catch (err) {
    logger.warn("cloud image generation failed:", err);
    return {
      success: false,
      outputPath,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
