import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

// =============================================================================
// Capacitor Schemas
// =============================================================================

export const AppIdParamsSchema = z.object({
  appId: z.number(),
});

// =============================================================================
// Capacitor Contracts
// =============================================================================

export const capacitorContracts = {
  isCapacitor: defineContract({
    channel: "is-capacitor",
    input: AppIdParamsSchema,
    output: z.boolean(),
  }),

  syncCapacitor: defineContract({
    channel: "sync-capacitor",
    input: AppIdParamsSchema,
    output: z.void(),
  }),

  openIos: defineContract({
    channel: "open-ios",
    input: AppIdParamsSchema,
    output: z.void(),
  }),

  openAndroid: defineContract({
    channel: "open-android",
    input: AppIdParamsSchema,
    output: z.void(),
  }),

  // Whether a usable Android Studio install is present (used to hide the
  // "Sync & Open Android" button when it would only crash).
  isAndroidStudioAvailable: defineContract({
    channel: "is-android-studio-available",
    input: z.void(),
    output: z.boolean(),
  }),

  // Whether Xcode is available (macOS only) — used to hide the "Sync & Open
  // iOS" button on machines that can't open it.
  isXcodeAvailable: defineContract({
    channel: "is-xcode-available",
    input: z.void(),
    output: z.boolean(),
  }),
} as const;

// =============================================================================
// Capacitor Client
// =============================================================================

export const capacitorClient = createClient(capacitorContracts);
