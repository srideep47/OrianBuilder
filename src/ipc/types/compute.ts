import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

// =============================================================================
// Schemas
// =============================================================================

export const ComputeModeSchema = z.enum(["auto", "local", "peer"]);
export type ComputeMode = z.infer<typeof ComputeModeSchema>;

export const ComputeTargetSchema = z.object({
  mode: ComputeModeSchema,
  peerId: z.string().optional(),
});
export type ComputeTarget = z.infer<typeof ComputeTargetSchema>;

export const ComputeNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  isLocal: z.boolean(),
  gpuUtilization: z.number(),
  loadedModels: z.array(z.string()),
  computeAvailable: z.boolean(),
  latencyMs: z.number().nullable(),
  hardware: z
    .object({
      cpu: z.string(),
      ramGB: z.number(),
      gpu: z.string(),
      vramGB: z.number(),
    })
    .nullable(),
});
export type ComputeNode = z.infer<typeof ComputeNodeSchema>;

export const ShareConfigSchema = z.object({
  enabled: z.boolean(),
  maxConcurrent: z.number().int().min(1).max(8),
  vramLimitGB: z.number().optional(),
});
export type ShareConfig = z.infer<typeof ShareConfigSchema>;

export const ShareStatusSchema = z.object({
  enabled: z.boolean(),
  maxConcurrent: z.number(),
  activeRequestCount: z.number(),
  proxyPort: z.number(),
});

// =============================================================================
// Contracts
// =============================================================================

export const computeContracts = {
  getAvailableNodes: defineContract({
    channel: "compute:get-available-nodes",
    input: z.void(),
    output: z.array(ComputeNodeSchema),
  }),
  getTarget: defineContract({
    channel: "compute:get-target",
    input: z.void(),
    output: ComputeTargetSchema,
  }),
  setTarget: defineContract({
    channel: "compute:set-target",
    input: ComputeTargetSchema,
    output: z.object({ success: z.boolean(), proxyActive: z.boolean() }),
  }),
  setSharing: defineContract({
    channel: "compute:set-sharing",
    input: ShareConfigSchema,
    output: z.object({ success: z.boolean() }),
  }),
  getShareStatus: defineContract({
    channel: "compute:get-share-status",
    input: z.void(),
    output: ShareStatusSchema,
  }),
} as const;

export const computeClient = createClient(computeContracts);
