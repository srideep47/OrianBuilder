import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

// =============================================================================
// Schemas
// =============================================================================

export const DeviceHardwareSchema = z.object({
  cpu: z.string(),
  ramGB: z.number(),
  gpu: z.string(),
  vramGB: z.number(),
});
export type DeviceHardware = z.infer<typeof DeviceHardwareSchema>;

export const DeviceIdentitySchema = z.object({
  publicKey: z.string(),
  fingerprint: z.string(),
  deviceName: z.string(),
  deviceType: z.enum(["desktop", "laptop", "server"]),
  hardware: DeviceHardwareSchema.nullable(),
});
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>;

export const UpdateDeviceInputSchema = z.object({
  deviceName: z.string().optional(),
  deviceType: z.enum(["desktop", "laptop", "server"]).optional(),
});
export type UpdateDeviceInput = z.infer<typeof UpdateDeviceInputSchema>;

// =============================================================================
// Contracts
// =============================================================================

export const identityContracts = {
  get: defineContract({
    channel: "identity:get",
    input: z.void(),
    output: DeviceIdentitySchema,
  }),

  updateDevice: defineContract({
    channel: "identity:update-device",
    input: UpdateDeviceInputSchema,
    output: DeviceIdentitySchema,
  }),

  reset: defineContract({
    channel: "identity:reset",
    input: z.void(),
    output: DeviceIdentitySchema,
  }),
} as const;

export const identityClient = createClient(identityContracts);
