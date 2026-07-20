import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { ORIANBUILDER_MEDIA_DIR_NAME } from "@/ipc/utils/media_path_utils";
import { getCachedHardwareProfile } from "@/main/hardware/detect";
import {
  applySelectionToProfile,
  modelConfigForAsset,
  selectProfileForVram,
} from "@/main/flow/model_profiles";
import { getModelGate } from "@/main/flow/model_gate";
import { configureModelGateHooks } from "@/main/flow/pipeline_wiring";
import { dispatchMediaGeneration } from "@/main/ipc/utils/media_dispatcher";
import { readSettings } from "@/main/settings";
import { resolveSelection } from "@/shared/orion_media_catalog";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";

const DEFAULT_MEDIA_BACKEND_URL = "http://localhost:8000";
const MAX_MEDIA_BYTES = 250 * 1024 * 1024;

const generateMediaAssetSchema = z.object({
  kind: z
    .enum(["image", "audio", "video"])
    .describe("The media type to generate."),
  prompt: z
    .string()
    .min(1)
    .describe("Detailed generation prompt or text-to-speech script."),
  backend_url: z
    .string()
    .url()
    .optional()
    .default(DEFAULT_MEDIA_BACKEND_URL)
    .describe(
      "Media generation backend base URL. Defaults to http://localhost:8000.",
    ),
  timeout_seconds: z
    .number()
    .min(10)
    .max(1800)
    .optional()
    .default(300)
    .describe("Maximum seconds to wait for generation and download."),
});

type GenerateMediaAssetArgs = z.infer<typeof generateMediaAssetSchema>;

const MIME_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

const DEFAULT_EXTENSION: Record<GenerateMediaAssetArgs["kind"], string> = {
  image: ".png",
  audio: ".wav",
  video: ".mp4",
};

const DEFAULT_MIME: Record<GenerateMediaAssetArgs["kind"], string> = {
  image: "image/png",
  audio: "audio/wav",
  video: "video/mp4",
};

function getMediaUrlFromResponse(
  kind: GenerateMediaAssetArgs["kind"],
  data: unknown,
): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  const candidates = [
    `${kind}_url`,
    "url",
    "media_url",
    "file_url",
    "output_url",
  ];
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function getBase64FromResponse(
  kind: GenerateMediaAssetArgs["kind"],
  data: unknown,
): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  const candidates = [
    `${kind}_b64`,
    `${kind}_base64`,
    "b64_json",
    "base64",
    "data",
  ];
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().replace(/^data:[^;]+;base64,/, "");
    }
  }
  return null;
}

function getFilenameFromResponse(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const value = (data as Record<string, unknown>).filename;
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return path.basename(value.trim());
}

function resolveMediaUrl(baseUrl: string, mediaUrl: string): string {
  return new URL(mediaUrl, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
    .href;
}

function getExtension(input: {
  kind: GenerateMediaAssetArgs["kind"];
  mimeType?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
}) {
  const mimeExtension = input.mimeType
    ? MIME_EXTENSION[input.mimeType.toLowerCase()]
    : undefined;
  if (mimeExtension) {
    return mimeExtension;
  }
  const fileExtension = path
    .extname(input.filename || input.mediaUrl || "")
    .toLowerCase();
  return fileExtension || DEFAULT_EXTENSION[input.kind];
}

function sanitizePromptForFileName(prompt: string) {
  return (
    prompt
      .slice(0, 32)
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "asset"
  );
}

async function generateThroughOrionRuntime(input: {
  kind: GenerateMediaAssetArgs["kind"];
  prompt: string;
  appPath: string;
}): Promise<{ relativePath: string; mimeType: string }> {
  const assetType = input.kind === "audio" ? "speech" : input.kind;
  const hardware = await getCachedHardwareProfile();
  const settings = readSettings();
  const profile = applySelectionToProfile(
    selectProfileForVram(hardware?.primaryGpu?.vramMb ?? 0),
    resolveSelection(settings.orionMediaModels),
  );
  const stage = modelConfigForAsset(profile, assetType);
  const mediaDir = path.join(input.appPath, ORIANBUILDER_MEDIA_DIR_NAME);
  await fs.mkdir(mediaDir, { recursive: true });
  const extension = DEFAULT_EXTENSION[input.kind];
  const fileName = `generated-${input.kind}-${sanitizePromptForFileName(input.prompt)}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${extension}`;
  const outputPath = path.join(mediaDir, fileName);

  configureModelGateHooks();
  const result = await getModelGate().with(
    {
      kind: assetType,
      modelId: stage.modelId,
      vramMb: stage.vramMb,
    },
    () =>
      dispatchMediaGeneration({
        modelType: input.kind,
        prompt: input.prompt,
        outputPath,
        modelId: stage.modelId,
        options: stage.defaultSettings,
      }),
  );

  if (!result.success || result.error?.toLowerCase().includes("placeholder")) {
    throw new OrianBuilderError(
      result.error ?? `Orion could not generate the ${input.kind} asset.`,
      OrianBuilderErrorKind.External,
    );
  }
  return {
    relativePath: path.join(ORIANBUILDER_MEDIA_DIR_NAME, fileName),
    mimeType: DEFAULT_MIME[input.kind],
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadGeneratedMedia(input: {
  kind: GenerateMediaAssetArgs["kind"];
  prompt: string;
  backendUrl: string;
  data: unknown;
  timeoutMs: number;
  appPath: string;
}) {
  const mediaUrl = getMediaUrlFromResponse(input.kind, input.data);
  const b64 = getBase64FromResponse(input.kind, input.data);
  const filename = getFilenameFromResponse(input.data);
  let buffer: Buffer;
  let mimeType: string | null = null;

  if (b64) {
    buffer = Buffer.from(b64, "base64");
  } else if (mediaUrl) {
    const resolvedUrl = resolveMediaUrl(input.backendUrl, mediaUrl);
    const response = await fetchWithTimeout(
      resolvedUrl,
      { method: "GET" },
      input.timeoutMs,
    );
    if (!response.ok) {
      throw new OrianBuilderError(
        `Failed to download generated ${input.kind}: HTTP ${response.status}`,
        OrianBuilderErrorKind.External,
      );
    }
    mimeType = response.headers.get("content-type")?.split(";")[0] ?? null;
    buffer = Buffer.from(await response.arrayBuffer());
  } else {
    throw new OrianBuilderError(
      `Media backend did not return a ${input.kind} URL or base64 payload.`,
      OrianBuilderErrorKind.External,
    );
  }

  if (buffer.byteLength > MAX_MEDIA_BYTES) {
    throw new OrianBuilderError(
      `Generated ${input.kind} exceeds the ${Math.floor(MAX_MEDIA_BYTES / 1024 / 1024)} MB limit.`,
      OrianBuilderErrorKind.Validation,
    );
  }

  const extension = getExtension({
    kind: input.kind,
    mimeType,
    mediaUrl,
    filename,
  });
  const finalMimeType = mimeType ?? DEFAULT_MIME[input.kind];
  const mediaDir = path.join(input.appPath, ORIANBUILDER_MEDIA_DIR_NAME);
  await fs.mkdir(mediaDir, { recursive: true });
  const fileName = `generated-${input.kind}-${sanitizePromptForFileName(input.prompt)}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${extension}`;
  const filePath = path.join(mediaDir, fileName);
  await fs.writeFile(filePath, buffer);

  return {
    relativePath: path.join(ORIANBUILDER_MEDIA_DIR_NAME, fileName),
    mimeType: finalMimeType,
  };
}

export const generateMediaAssetTool: ToolDefinition<GenerateMediaAssetArgs> = {
  name: "generate_media_asset",
  description: `Generate image, audio, or video assets through a configurable local media backend and save the result to the app's .orianbuilder/media directory.

Use this when the app needs durable generated media beyond a single image: audio clips, short videos, or image assets. The default uses Orion's plan-aware single-resident runtime and the user's selected local model. A custom backend URL may expose POST /generate/image, /generate/audio, and /generate/video endpoints that return a media URL or base64 payload.`,
  inputSchema: generateMediaAssetSchema,
  defaultConsent: "always",
  modifiesState: true,

  getConsentPreview: (args) =>
    `Generate ${args.kind} asset: "${args.prompt.slice(0, 120)}"`,

  buildXml: (args, isComplete) => {
    if (!args.kind || !args.prompt || isComplete) return undefined;
    return `<orianbuilder-media-generation kind="${escapeXmlAttr(args.kind)}" prompt="${escapeXmlAttr(args.prompt)}" provider="media_backend">`;
  },

  execute: async (args, ctx: AgentContext) => {
    const backendUrl = args.backend_url ?? DEFAULT_MEDIA_BACKEND_URL;
    const timeoutMs = (args.timeout_seconds ?? 300) * 1000;
    ctx.onXmlStream(
      `<orianbuilder-media-generation kind="${escapeXmlAttr(args.kind)}" prompt="${escapeXmlAttr(args.prompt)}" provider="${escapeXmlAttr(backendUrl)}">Generating ${escapeXmlContent(args.kind)}...`,
    );

    if (backendUrl.replace(/\/+$/, "") === DEFAULT_MEDIA_BACKEND_URL) {
      const saved = await generateThroughOrionRuntime({
        kind: args.kind,
        prompt: args.prompt,
        appPath: ctx.appPath,
      });
      const summary = `${args.kind} generated and saved to ${saved.relativePath}`;
      ctx.onXmlComplete(
        `<orianbuilder-media-generation kind="${escapeXmlAttr(args.kind)}" prompt="${escapeXmlAttr(args.prompt)}" provider="orion-runtime" path="${escapeXmlAttr(saved.relativePath)}" mime-type="${escapeXmlAttr(saved.mimeType)}">${escapeXmlContent(summary)}</orianbuilder-media-generation>`,
      );
      return summary;
    }

    const endpoint = `${backendUrl.replace(/\/+$/, "")}/generate/${args.kind}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: args.prompt }),
        },
        timeoutMs,
      );
    } catch (error) {
      throw new OrianBuilderError(
        `Media backend is unavailable at ${backendUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        OrianBuilderErrorKind.External,
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new OrianBuilderError(
        `Media backend failed (${response.status}): ${errorText.slice(0, 500)}`,
        OrianBuilderErrorKind.External,
      );
    }

    const data = await response.json();
    const saved = await downloadGeneratedMedia({
      kind: args.kind,
      prompt: args.prompt,
      backendUrl,
      data,
      timeoutMs,
      appPath: ctx.appPath,
    });

    const summary = `${args.kind} generated and saved to ${saved.relativePath}`;
    ctx.onXmlComplete(
      `<orianbuilder-media-generation kind="${escapeXmlAttr(args.kind)}" prompt="${escapeXmlAttr(args.prompt)}" provider="${escapeXmlAttr(backendUrl)}" path="${escapeXmlAttr(saved.relativePath)}" mime-type="${escapeXmlAttr(saved.mimeType)}">${escapeXmlContent(summary)}</orianbuilder-media-generation>`,
    );
    return summary;
  },
};
