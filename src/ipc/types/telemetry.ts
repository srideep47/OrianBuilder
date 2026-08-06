import { z } from "zod";

import { createClient, defineContract } from "../contracts/core";

// =============================================================================
// Schemas
// =============================================================================

export const GpuLiveSampleSchema = z.object({
  index: z.number(),
  name: z.string(),
  utilizationPercent: z.number().nullable(),
  memoryUsedMb: z.number().nullable(),
  memoryTotalMb: z.number().nullable(),
  temperatureC: z.number().nullable(),
  powerWatts: z.number().nullable(),
  powerLimitWatts: z.number().nullable(),
  clockMhz: z.number().nullable(),
});
export type GpuLiveSample = z.infer<typeof GpuLiveSampleSchema>;

export const LiveTelemetrySampleSchema = z.object({
  capturedAt: z.number(),
  gpus: z.array(GpuLiveSampleSchema),
  gpuUnavailableReason: z.string().nullable(),
  cpu: z.object({
    percent: z.number().nullable(),
    perCore: z.array(z.number()),
    cores: z.number(),
    loadAverage: z.number().nullable(),
  }),
  memory: z.object({
    usedMb: z.number(),
    totalMb: z.number(),
    percent: z.number(),
    processRssMb: z.number(),
  }),
});
export type LiveTelemetrySample = z.infer<typeof LiveTelemetrySampleSchema>;

export const InferenceSampleSchema = z.object({
  actor: z.string(),
  modelId: z.string().nullable(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  durationMs: z.number(),
  timeToFirstTokenMs: z.number().nullable(),
  contextSize: z.number().nullable(),
  timestamp: z.number(),
});
export type InferenceSample = z.infer<typeof InferenceSampleSchema>;

export const InferenceTelemetrySchema = z.object({
  samples: z.array(InferenceSampleSchema),
  lastTokensPerSecond: z.number().nullable(),
  averageTokensPerSecond: z.number().nullable(),
  lastTimeToFirstTokenMs: z.number().nullable(),
  lastContextPercent: z.number().nullable(),
  totalPromptTokens: z.number(),
  totalCompletionTokens: z.number(),
});
export type InferenceTelemetry = z.infer<typeof InferenceTelemetrySchema>;

// =============================================================================
// Contracts
// =============================================================================

export const telemetryContracts = {
  /**
   * One sampled machine reading. Read-only and cheap enough to poll while a
   * telemetry surface is on the Stage; see `live_telemetry.ts` for why this is
   * pulled rather than pushed.
   */
  getLiveSample: defineContract({
    channel: "telemetry:get-live-sample",
    input: z.void(),
    output: LiveTelemetrySampleSchema,
  }),

  /** Decode rate, time-to-first-token and context occupancy of recent model calls. */
  getInference: defineContract({
    channel: "telemetry:get-inference",
    input: z.void(),
    output: InferenceTelemetrySchema,
  }),
} as const;

export const telemetryClient = createClient(telemetryContracts);
