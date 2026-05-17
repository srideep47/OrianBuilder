import { z } from "zod";
import { createClient, defineContract } from "../contracts/core";

export const MediaAiModelIdSchema = z.enum(["text", "image", "audio", "video"]);

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
  requirementsPath: z.string(),
  requirementsAvailable: z.boolean(),
  modelsPath: z.string(),
  outputsPath: z.string(),
  models: z.array(MediaAiModelStatusSchema),
  lastLog: z.string().optional(),
});

export const MediaAiOperationResultSchema = z.object({
  success: z.boolean(),
  output: z.string().optional(),
});

export const DownloadMediaAiModelsParamsSchema = z.object({
  models: z.array(MediaAiModelIdSchema).min(1),
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
