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

export const AndroidEmulatorStatusSchema = z.object({
  sdkReady: z.boolean(),
  imageReady: z.boolean(),
  emulatorRunning: z.boolean(),
  avdName: z.string().nullable(),
});

export const AndroidSetupProgressSchema = z.object({
  stage: z.enum([
    "resolving",
    "platform-tools",
    "emulator",
    "system-image",
    "avd",
    "done",
  ]),
  label: z.string(),
  percent: z.number(),
  bytesDownloaded: z.number(),
  totalBytes: z.number(),
});

export const AndroidOperationResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});

export const AndroidFindApkParamsSchema = z.object({
  appId: z.number(),
});

export const AndroidFindApkResultSchema = z.object({
  apkPath: z.string().nullable(),
  packageId: z.string().nullable(),
});

export const AndroidLaunchParamsSchema = z.object({
  apkPath: z.string(),
  packageId: z.string().nullable().optional(),
});

export const AndroidBuildResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  apkPath: z.string().nullable(),
});

export const AndroidBuildLogSchema = z.object({
  line: z.string(),
});

// =============================================================================
// Contracts
// =============================================================================

export const androidEmulatorContracts = {
  getStatus: defineContract({
    channel: "android_emulator:getStatus",
    input: z.void(),
    output: AndroidEmulatorStatusSchema,
  }),
  setup: defineContract({
    channel: "android_emulator:setup",
    input: z.void(),
    output: AndroidOperationResultSchema,
  }),
  abort: defineContract({
    channel: "android_emulator:abort",
    input: z.void(),
    output: z.void(),
  }),
  findApk: defineContract({
    channel: "android_emulator:findApk",
    input: AndroidFindApkParamsSchema,
    output: AndroidFindApkResultSchema,
  }),
  launchAndInstall: defineContract({
    channel: "android_emulator:launchAndInstall",
    input: AndroidLaunchParamsSchema,
    output: AndroidOperationResultSchema,
  }),
  buildApk: defineContract({
    channel: "android_emulator:buildApk",
    input: AndroidFindApkParamsSchema,
    output: AndroidBuildResultSchema,
  }),
  abortBuild: defineContract({
    channel: "android_emulator:abortBuild",
    input: z.void(),
    output: z.void(),
  }),
  stop: defineContract({
    channel: "android_emulator:stop",
    input: z.void(),
    output: AndroidOperationResultSchema,
  }),
} as const;

// =============================================================================
// Events (main → renderer)
// =============================================================================

export const androidEmulatorEvents = {
  setupProgress: defineEvent({
    channel: "android_emulator:setup-progress",
    payload: AndroidSetupProgressSchema,
  }),
  buildLog: defineEvent({
    channel: "android_emulator:build-log",
    payload: AndroidBuildLogSchema,
  }),
} as const;

// =============================================================================
// Clients
// =============================================================================

export const androidEmulatorClient = createClient(androidEmulatorContracts);
export const androidEmulatorEventClient = createEventClient(
  androidEmulatorEvents,
);

// =============================================================================
// Type Exports
// =============================================================================

export type AndroidEmulatorStatus = z.infer<typeof AndroidEmulatorStatusSchema>;
export type AndroidSetupProgress = z.infer<typeof AndroidSetupProgressSchema>;
export type AndroidOperationResult = z.infer<
  typeof AndroidOperationResultSchema
>;
export type AndroidFindApkResult = z.infer<typeof AndroidFindApkResultSchema>;
export type AndroidLaunchParams = z.infer<typeof AndroidLaunchParamsSchema>;
export type AndroidBuildResult = z.infer<typeof AndroidBuildResultSchema>;
export type AndroidBuildLog = z.infer<typeof AndroidBuildLogSchema>;
