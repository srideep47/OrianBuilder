import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

// =============================================================================
// Schemas
// =============================================================================

export const HardwareGpuInfoSchema = z.object({
  vendor: z.enum(["nvidia", "amd", "intel", "apple", "unknown"]),
  model: z.string(),
  vramMb: z.number(),
  isIntegrated: z.boolean(),
});
export type HardwareGpuInfo = z.infer<typeof HardwareGpuInfoSchema>;

export const HardwareProfileSchema = z.object({
  os: z.enum(["windows", "macos", "linux"]),
  arch: z.enum(["x64", "arm64"]),
  cpu: z.object({
    vendor: z.enum(["amd", "intel", "apple", "unknown"]),
    model: z.string(),
    cores: z.number(),
    logicalCores: z.number(),
  }),
  gpus: z.array(HardwareGpuInfoSchema),
  primaryGpu: HardwareGpuInfoSchema.nullable(),
  totalRamMb: z.number(),
  availableBackends: z.array(
    z.enum(["cuda", "rocm", "metal", "vulkan", "directml", "openvino", "cpu"]),
  ),
  bestLlmBackend: z.enum(["cuda", "rocm", "metal", "vulkan", "cpu"]),
  bestMediaBackend: z.enum([
    "cuda",
    "rocm",
    "metal",
    "directml",
    "openvino",
    "cpu",
  ]),
});
export type HardwareProfile = z.infer<typeof HardwareProfileSchema>;

// =============================================================================
// Contracts
// =============================================================================

export const hardwareContracts = {
  getProfile: defineContract({
    channel: "hardware:get-profile",
    input: z.void(),
    output: HardwareProfileSchema,
  }),

  refreshProfile: defineContract({
    channel: "hardware:refresh-profile",
    input: z.void(),
    output: HardwareProfileSchema,
  }),
} as const;

export const hardwareClient = createClient(hardwareContracts);
