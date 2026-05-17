import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

// =============================================================================
// Schemas
// =============================================================================

export const OrchestratorStateSchema = z.enum([
  "idle",
  "llm-loading",
  "llm-loaded",
  "swapping-out",
  "media-loading",
  "media-loaded",
  "swapping-back",
]);
export type OrchestratorState = z.infer<typeof OrchestratorStateSchema>;

export const LlmLoadParamsSchema = z.object({
  modelPath: z.string(),
  gpuLayers: z.number(),
  contextSize: z.number(),
  modelSizeMb: z.number().optional(),
  totalLayers: z.number().optional(),
  quantFactor: z.number().optional(),
  kvBytesPerTokenPerLayer: z.number().optional(),
});
export type LlmLoadParams = z.infer<typeof LlmLoadParamsSchema>;

export const MediaQualitySchema = z.enum([
  "ultra",
  "best",
  "good",
  "basic",
  "slow",
]);
export type MediaQuality = z.infer<typeof MediaQualitySchema>;

export const MediaTierSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  vramRequiredMb: z.number(),
  downloadSizeMb: z.number().optional(),
  quality: MediaQualitySchema,
  hfRepo: z.string().optional(),
  approxSecondsPerGen: z.number().optional(),
});
export type MediaTier = z.infer<typeof MediaTierSchema>;

export const AvailableTiersSchema = z.object({
  image: z.array(MediaTierSchema),
  audio: z.array(MediaTierSchema),
  audioStt: z.array(MediaTierSchema),
  video: z.array(MediaTierSchema),
  projectedAvailableVramMb: z.number(),
});
export type AvailableTiers = z.infer<typeof AvailableTiersSchema>;

export const MediaGenerationRequestSchema = z.object({
  modelType: z.enum(["image", "audio", "video", "music", "transcribe"]),
  prompt: z.string(),
  outputPath: z.string(),
  options: z.record(z.string(), z.unknown()).optional(),
  preferredQuality: MediaQualitySchema.optional(),
});
export type MediaGenerationRequest = z.infer<
  typeof MediaGenerationRequestSchema
>;

export const MediaGenerationResultSchema = z.object({
  success: z.boolean(),
  outputPath: z.string(),
  durationMs: z.number(),
  error: z.string().optional(),
});
export type MediaGenerationResult = z.infer<typeof MediaGenerationResultSchema>;

export const OrchestratorStatusSchema = z.object({
  state: OrchestratorStateSchema,
  currentLlmModel: z.string().nullable(),
  currentMediaModel: z.string().nullable(),
  lastSwapDurationMs: z.number().nullable(),
});
export type OrchestratorStatus = z.infer<typeof OrchestratorStatusSchema>;

// =============================================================================
// Contracts
// =============================================================================

export const orchestratorContracts = {
  getStatus: defineContract({
    channel: "orchestrator:get-status",
    input: z.void(),
    output: OrchestratorStatusSchema,
  }),
  acquireLlm: defineContract({
    channel: "orchestrator:acquire-llm",
    input: LlmLoadParamsSchema,
    output: z.void(),
  }),
  runMedia: defineContract({
    channel: "orchestrator:run-media",
    input: MediaGenerationRequestSchema,
    output: MediaGenerationResultSchema,
  }),
  releaseAll: defineContract({
    channel: "orchestrator:release-all",
    input: z.void(),
    output: z.void(),
  }),
  getAvailableTiers: defineContract({
    channel: "orchestrator:get-available-tiers",
    input: z.void(),
    output: AvailableTiersSchema,
  }),
} as const;

export const orchestratorClient = createClient(orchestratorContracts);
