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

export const LlamaBinaryCheckResultSchema = z.object({
  exists: z.boolean(),
  variant: z.string().nullable(),
  path: z.string().nullable(),
});

export const LlamaBinaryDownloadProgressSchema = z.object({
  stage: z.enum(["resolving", "downloading", "extracting", "companions", "done"]),
  label: z.string(),
  percent: z.number(),
  bytesDownloaded: z.number(),
  totalBytes: z.number(),
});

export const LlamaBinaryDownloadResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});

// =============================================================================
// Contracts
// =============================================================================

export const llamaBinaryContracts = {
  check: defineContract({
    channel: "llama-binary:check",
    input: z.void(),
    output: LlamaBinaryCheckResultSchema,
  }),
  download: defineContract({
    channel: "llama-binary:download",
    input: z.void(),
    output: LlamaBinaryDownloadResultSchema,
  }),
  abort: defineContract({
    channel: "llama-binary:abort",
    input: z.void(),
    output: z.void(),
  }),
  restart: defineContract({
    channel: "llama-binary:restart",
    input: z.void(),
    output: z.void(),
  }),
} as const;

// =============================================================================
// Events (main → renderer)
// =============================================================================

export const llamaBinaryEvents = {
  progress: defineEvent({
    channel: "llama-binary:progress",
    payload: LlamaBinaryDownloadProgressSchema,
  }),
} as const;

// =============================================================================
// Clients
// =============================================================================

export const llamaBinaryClient = createClient(llamaBinaryContracts);
export const llamaBinaryEventClient = createEventClient(llamaBinaryEvents);

// =============================================================================
// Type Exports
// =============================================================================

export type LlamaBinaryCheckResult = z.infer<typeof LlamaBinaryCheckResultSchema>;
export type LlamaBinaryDownloadProgress = z.infer<typeof LlamaBinaryDownloadProgressSchema>;
export type LlamaBinaryDownloadResult = z.infer<typeof LlamaBinaryDownloadResultSchema>;
