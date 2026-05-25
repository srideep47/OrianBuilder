import { z } from "zod";
import { createClient, defineContract } from "../contracts/core";

// Coarse model groups + specific image tier IDs that the user can download
// individually from the Media AI page dropdown. Adding a new tier here means
// also updating MODEL_LABELS (utils/media_ai_backend.ts) and the
// IMAGE_TIER_REPOS table (scripts/download_models.py).
export const MediaAiModelIdSchema = z.enum([
  "text",
  "image",
  "audio",
  "video",
  "image-sd-turbo",
  "image-z-image-turbo",
  "whisper",
]);

export const MediaAiModelStatusSchema = z.object({
  id: MediaAiModelIdSchema,
  label: z.string(),
  downloaded: z.boolean(),
  markerPath: z.string().optional(),
});

export const MediaAiStatusSchema = z.object({
  backendPath: z.string(),
  backendAvailable: z.boolean(),
  serverUrl: z.string(),
  running: z.boolean(),
  healthy: z.boolean(),
  venvPath: z.string(),
  pythonPath: z.string(),
  venvExists: z.boolean(),
  /** True when the venv exists AND the minimum Python packages (fastapi, uvicorn,
   *  diffusers) are present. False when the venv was created but pip install was
   *  interrupted (e.g. lost internet), so the backend cannot start. */
  depsInstalled: z.boolean(),
  requirementsPath: z.string(),
  requirementsAvailable: z.boolean(),
  modelsPath: z.string(),
  outputsPath: z.string(),
  models: z.array(MediaAiModelStatusSchema),
  lastLog: z.string().optional(),
  gpuBackendInstalled: z.string().optional(),
});

export const MediaAiOperationResultSchema = z.object({
  success: z.boolean(),
  output: z.string().optional(),
});

export const DownloadMediaAiModelsParamsSchema = z.object({
  models: z.array(MediaAiModelIdSchema).min(1),
});

export const InstallForBackendParamsSchema = z.object({
  backend: z
    .enum([
      "cuda",
      "rocm",
      "metal",
      "mps",
      "vulkan",
      "directml",
      "openvino",
      "cpu",
    ])
    .optional(),
});
export type InstallForBackendParams = z.infer<
  typeof InstallForBackendParamsSchema
>;

// Generic image proxy: fetches a URL from the Electron main process (where
// there are no CORS / Origin / Referer restrictions) and returns the bytes
// as base64. Used by the cloud image/video paths to bypass the browser-side
// fetch limits that block Pollinations.ai from the renderer.
export const FetchCloudImageParamsSchema = z.object({
  url: z.string().url(),
});
export const FetchCloudImageResultSchema = z.object({
  base64: z.string(),
  contentType: z.string(),
});

export const mediaAiContracts = {
  getStatus: defineContract({
    channel: "media-ai:get-status",
    input: z.void(),
    output: MediaAiStatusSchema,
  }),
  installDependencies: defineContract({
    channel: "media-ai:install-dependencies",
    input: z.void(),
    output: MediaAiOperationResultSchema,
  }),
  installDependenciesForBackend: defineContract({
    channel: "media-ai:install-for-backend",
    input: InstallForBackendParamsSchema,
    output: MediaAiOperationResultSchema,
  }),
  installThreeDRuntime: defineContract({
    channel: "media-ai:install-3d-runtime",
    input: InstallForBackendParamsSchema,
    output: MediaAiOperationResultSchema,
  }),
  downloadModels: defineContract({
    channel: "media-ai:download-models",
    input: DownloadMediaAiModelsParamsSchema,
    output: MediaAiOperationResultSchema,
  }),
  startBackend: defineContract({
    channel: "media-ai:start-backend",
    input: z.void(),
    output: MediaAiStatusSchema,
  }),
  stopBackend: defineContract({
    channel: "media-ai:stop-backend",
    input: z.void(),
    output: MediaAiStatusSchema,
  }),
  cancelDownload: defineContract({
    channel: "media-ai:cancel-download",
    input: z.void(),
    output: z.object({ cancelled: z.boolean() }),
  }),
  fetchCloudImage: defineContract({
    channel: "media-ai:fetch-cloud-image",
    input: FetchCloudImageParamsSchema,
    output: FetchCloudImageResultSchema,
  }),
  deleteModel: defineContract({
    channel: "media-ai:delete-model",
    input: z.object({ modelId: MediaAiModelIdSchema }),
    output: z.object({ deleted: z.boolean() }),
  }),
  resetSetup: defineContract({
    channel: "media-ai:reset-setup",
    input: z.object({ alsoDeleteModels: z.boolean().default(false) }),
    output: z.object({ removed: z.array(z.string()) }),
  }),
} as const;

export const mediaAiClient = createClient(mediaAiContracts);

export type MediaAiModelId = z.infer<typeof MediaAiModelIdSchema>;
export type MediaAiModelStatus = z.infer<typeof MediaAiModelStatusSchema>;
export type MediaAiStatus = z.infer<typeof MediaAiStatusSchema>;
export type MediaAiOperationResult = z.infer<
  typeof MediaAiOperationResultSchema
>;
export type DownloadMediaAiModelsParams = z.infer<
  typeof DownloadMediaAiModelsParamsSchema
>;
