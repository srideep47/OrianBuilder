import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

// =============================================================================
// Schemas
// =============================================================================

export const GpuInfoSchema = z.object({
  available: z.boolean(),
  name: z.string(),
  vramMb: z.number(),
  computeCapability: z.number(),
  hasTensorCores: z.boolean(),
  tensorCoreGen: z.string(),
  recommendedGpuLayers: z.number(),
});
export type GpuInfo = z.infer<typeof GpuInfoSchema>;

export const GpuStatsSchema = z.object({
  utilizationPercent: z.number(),
  vramUsedMb: z.number(),
  vramTotalMb: z.number(),
  temperatureC: z.number(),
  powerW: z.number(),
  clockMhz: z.number(),
});
export type GpuStats = z.infer<typeof GpuStatsSchema>;

export const EmbeddedServerStatusSchema = z.object({
  running: z.boolean(),
  modelLoaded: z.boolean(),
  modelPath: z.string().nullable(),
  isLoading: z.boolean(),
  modelName: z.string().nullable(),
  tokensGenerated: z.number(),
  lastTokensPerSec: z.number(),
});
export type EmbeddedServerStatus = z.infer<typeof EmbeddedServerStatusSchema>;

export const EmbeddedModelConfigSchema = z.object({
  modelPath: z.string(),
  gpuLayers: z.number(),
  contextSize: z.number(),
  batchSize: z.number(),
  temperature: z.number(),
  topP: z.number(),
  topK: z.number(),
  repeatPenalty: z.number(),
  seed: z.number().nullable(),
  flashAttention: z.boolean(),
});
export type EmbeddedModelConfig = z.infer<typeof EmbeddedModelConfigSchema>;

export const EmbeddedLoadResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

// =============================================================================
// Contracts
// =============================================================================

export const embeddedModelContracts = {
  getStatus: defineContract({
    channel: "embedded-model:get-status",
    input: z.void(),
    output: EmbeddedServerStatusSchema,
  }),

  detectGpu: defineContract({
    channel: "embedded-model:detect-gpu",
    input: z.number().optional(),
    output: GpuInfoSchema,
  }),

  getGpuStats: defineContract({
    channel: "embedded-model:get-gpu-stats",
    input: z.void(),
    output: GpuStatsSchema.nullable(),
  }),

  selectGguf: defineContract({
    channel: "embedded-model:select-gguf",
    input: z.void(),
    output: z.string().nullable(),
  }),

  loadModel: defineContract({
    channel: "embedded-model:load",
    input: EmbeddedModelConfigSchema,
    output: EmbeddedLoadResultSchema,
  }),

  unloadModel: defineContract({
    channel: "embedded-model:unload",
    input: z.void(),
    output: EmbeddedLoadResultSchema,
  }),

  getSavedConfig: defineContract({
    channel: "embedded-model:get-saved-config",
    input: z.void(),
    output: EmbeddedModelConfigSchema.partial().extend({
      modelPath: z.string().nullable(),
    }),
  }),

  saveConfig: defineContract({
    channel: "embedded-model:save-config",
    input: EmbeddedModelConfigSchema.partial().extend({
      modelPath: z.string().nullable().optional(),
    }),
    output: z.void(),
  }),
} as const;

export const embeddedModelClient = createClient(embeddedModelContracts);
