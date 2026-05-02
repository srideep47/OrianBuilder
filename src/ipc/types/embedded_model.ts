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
  sharedSystemMemoryUsedMb: z.number(),
  dedicatedMemoryUsedMb: z.number(),
  memoryOverflowMb: z.number(),
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
  modelName: z.string().nullable().optional(),
  backend: z.enum(["none", "llama-cpp", "tensorrt-native"]),
  tensorRtRunnerAvailable: z.boolean(),
  tensorRtRuntimeAvailable: z.boolean(),
  tensorRtRuntimePath: z.string().nullable(),
  tensorRtEngineDir: z.string().nullable(),
  tensorRtEngineFormat: z
    .enum(["tensorrt-llm", "tensorrt-plan", "unknown"])
    .nullable()
    .optional(),
  tokensGenerated: z.number().optional(),
  lastTokensPerSec: z.number().optional(),
  gpuLayers: z.number(),
  totalLayers: z.number(),
  cpuLayers: z.number(),
  actualContextSize: z.number(),
});
export type EmbeddedServerStatus = z.infer<typeof EmbeddedServerStatusSchema>;

export const EmbeddedModelConfigSchema = z.object({
  modelPath: z.string(),
  inferenceBackend: z.enum(["llama-cpp", "tensorrt-native"]).optional(),
  tensorRtEngineDir: z.string().nullable().optional(),
  // Legacy cap kept for saved configs. New UI uses vramHeadroomMb so the
  // loader can use almost all VRAM while leaving an explicit safety margin.
  gpuMemoryUtilization: z.number(),
  vramHeadroomMb: z.number().optional(),
  contextSize: z.number(),
  batchSize: z.number(),
  temperature: z.number(),
  topP: z.number(),
  topK: z.number(),
  repeatPenalty: z.number(),
  seed: z.number().nullable(),
  flashAttention: z.boolean(),
  aggressiveMemory: z.boolean().optional(),
  gpuLayersMode: z.enum(["auto", "manual"]).optional(),
  manualGpuLayers: z.number().nullable().optional(),
  // Internal: populated by model-info scan, used by the loader
  _estimatedLayers: z.number().optional(),
  _layerSizeMb: z.number().optional(),
  _vramMb: z.number().optional(),
  _kvBytesPerTokenPerLayer: z.number().optional(),
  _attentionSlidingWindow: z.number().nullable().optional(),
  _attentionSlidingWindowPattern: z.number().nullable().optional(),
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
  attentionSlidingWindow: z.number().nullable().optional(),
  attentionSlidingWindowPattern: z.number().nullable().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const EmbeddedLoadResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

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
  backend: z.enum(["none", "llama-cpp", "tensorrt-native"]),
  liveTps: z.number(),
  avgTps: z.number(),
  prefillTps: z.number(),
  promptTokens: z.number(),
  prefillDurationMs: z.number(),
  decodeTps: z.number(),
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

export const TensorRtEngineBuildStatusSchema = z.object({
  running: z.boolean(),
  phase: z.enum([
    "idle",
    "checking",
    "building",
    "done",
    "failed",
    "cancelled",
  ]),
  message: z.string(),
  outputDir: z.string().nullable(),
  onnxPath: z.string().nullable(),
  modelId: z.string(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  exitCode: z.number().nullable(),
});
export type TensorRtEngineBuildStatus = z.infer<
  typeof TensorRtEngineBuildStatusSchema
>;

export const TensorRtEngineBuildRequestSchema = z.object({
  modelId: z.string().default("Qwen/Qwen2.5-0.5B-Instruct"),
  outputDir: z.string().nullable().optional(),
  onnxPath: z.string().nullable().optional(),
  maxBatch: z.number().optional(),
  maxInputLen: z.number().optional(),
  maxSeqLen: z.number().optional(),
  dtype: z.enum(["fp16", "fp32"]).optional(),
});
export type TensorRtEngineBuildRequest = z.infer<
  typeof TensorRtEngineBuildRequestSchema
>;

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

  selectTensorRtEngineDir: defineContract({
    channel: "embedded-model:select-tensorrt-engine-dir",
    input: z.void(),
    output: z.string().nullable(),
  }),

  selectTensorRtOnnx: defineContract({
    channel: "embedded-model:select-tensorrt-onnx",
    input: z.void(),
    output: z.string().nullable(),
  }),

  startTensorRtEngineBuild: defineContract({
    channel: "embedded-model:start-tensorrt-engine-build",
    input: TensorRtEngineBuildRequestSchema,
    output: TensorRtEngineBuildStatusSchema,
  }),

  cancelTensorRtEngineBuild: defineContract({
    channel: "embedded-model:cancel-tensorrt-engine-build",
    input: z.void(),
    output: TensorRtEngineBuildStatusSchema,
  }),

  getTensorRtEngineBuildStatus: defineContract({
    channel: "embedded-model:get-tensorrt-engine-build-status",
    input: z.void(),
    output: TensorRtEngineBuildStatusSchema,
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
  getStats: defineContract({
    channel: "embedded-model:get-stats",
    input: z.void(),
    output: InferenceStatsSchema,
  }),
} as const;

// ─── Events ───────────────────────────────────────────────────────────────────

export const embeddedModelEvents = {
  stats: defineEvent({
    channel: "embedded-model:stats",
    payload: InferenceStatsSchema,
  }),
  log: defineEvent({
    channel: "embedded-model:log",
    payload: InferenceLogEntrySchema,
  }),
  tensorRtBuildStatus: defineEvent({
    channel: "embedded-model:tensorrt-build-status",
    payload: TensorRtEngineBuildStatusSchema,
  }),
} as const;

export const embeddedModelClient = createClient(embeddedModelContracts);
export const embeddedModelEventClient = createEventClient(embeddedModelEvents);
