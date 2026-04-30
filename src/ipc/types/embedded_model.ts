import { z } from "zod";
import {
  defineContract,
  defineEvent,
  createClient,
  createEventClient,
} from "../contracts/core";

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
  gpuLayers: z.number(),
  actualContextSize: z.number(),
});
export type EmbeddedServerStatus = z.infer<typeof EmbeddedServerStatusSchema>;

export const EmbeddedModelConfigSchema = z.object({
  modelPath: z.string(),
  // vLLM-style: fraction of total VRAM reserved for model weights (0.5–0.95).
  // The remaining VRAM is available for the KV cache.
  // Default 0.80 = 80% model, 20% context.
  gpuMemoryUtilization: z.number(),
  contextSize: z.number(),
  batchSize: z.number(),
  temperature: z.number(),
  topP: z.number(),
  topK: z.number(),
  repeatPenalty: z.number(),
  seed: z.number().nullable(),
  flashAttention: z.boolean(),
  // Internal: populated by model-info scan, used by the loader
  _estimatedLayers: z.number().optional(),
  _layerSizeMb: z.number().optional(),
  _vramMb: z.number().optional(),
});
export type EmbeddedModelConfig = z.infer<typeof EmbeddedModelConfigSchema>;

export const ModelInfoSchema = z.object({
  filePath: z.string(),
  fileName: z.string(),
  fileSizeMb: z.number(),
  paramBillions: z.number().nullable(),
  quantization: z.string(),
  estimatedLayers: z.number(),
  layerSizeMb: z.number(),
  recommendedGpuLayers: z.number(),
  recommendedContextSize: z.number(),
  maxSafeGpuLayers: z.number(),
  architecture: z.string().nullable().optional(),
  contextLengthTrained: z.number().nullable().optional(),
  kvBytesPerTokenPerLayer: z.number().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

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

  getModelInfo: defineContract({
    channel: "embedded-model:get-model-info",
    input: z.string(),
    output: ModelInfoSchema,
  }),
  getRecentLogs: defineContract({
    channel: "embedded-model:get-recent-logs",
    input: z.void(),
    output: z.array(
      z.object({
        ts: z.number(),
        level: z.enum(["info", "warn", "error"]),
        msg: z.string(),
      }),
    ),
  }),
} as const;

// ─── Events ───────────────────────────────────────────────────────────────────

const InferenceStateSchema = z.enum([
  "idle",
  "loading",
  "prefilling",
  "generating",
  "thinking",
  "tool_calling",
]);
export type InferenceState = z.infer<typeof InferenceStateSchema>;

export const InferenceStatsSchema = z.object({
  state: InferenceStateSchema,
  operation: z.string(),
  liveTps: z.number(),
  avgTps: z.number(),
  peakTps: z.number(),
  lowestTps: z.number(),
  tokensGenerated: z.number(),
  sessionDurationMs: z.number(),
  totalSessions: z.number(),
  totalTokensAllTime: z.number(),
});
export type InferenceStats = z.infer<typeof InferenceStatsSchema>;

export const InferenceLogEntrySchema = z.object({
  ts: z.number(),
  level: z.enum(["info", "warn", "error"]),
  msg: z.string(),
});
export type InferenceLogEntry = z.infer<typeof InferenceLogEntrySchema>;

export const embeddedModelEvents = {
  stats: defineEvent({
    channel: "embedded-model:stats",
    payload: InferenceStatsSchema,
  }),
  log: defineEvent({
    channel: "embedded-model:log",
    payload: InferenceLogEntrySchema,
  }),
} as const;

export const embeddedModelClient = createClient(embeddedModelContracts);
export const embeddedModelEventClient = createEventClient(embeddedModelEvents);
