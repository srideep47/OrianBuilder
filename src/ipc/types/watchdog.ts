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

export const WatchdogStatusSchema = z.object({
  /** Whether the FastAPI child process is running and `/health` answered 200. */
  running: z.boolean(),
  host: z.string().nullable(),
  port: z.number().nullable(),
  pid: z.number().nullable(),
  /** Whether `runFullSetup` has previously succeeded on this machine. */
  setupComplete: z.boolean(),
  /** Tail of stderr from the most recent backend launch. Null while healthy. */
  lastError: z.string().nullable(),
});
export type WatchdogStatus = z.infer<typeof WatchdogStatusSchema>;

export const WatchdogSetupParamsSchema = z.object({
  /** Optional explicit path to a Python interpreter, e.g. when the host has
   *  Python installed but not on PATH. Empty/undefined uses auto-detection. */
  pythonOverride: z.string().nullable().optional(),
  /** When true, ignore the `.setup-complete` marker and reinstall. */
  force: z.boolean().optional(),
});
export type WatchdogSetupParams = z.infer<typeof WatchdogSetupParamsSchema>;

export const WatchdogSetupResultSchema = z.object({
  ok: z.boolean(),
  /** User-facing failure message when ok=false. Empty on success. */
  message: z.string(),
});
export type WatchdogSetupResult = z.infer<typeof WatchdogSetupResultSchema>;

export const WatchdogSetupPhaseSchema = z.enum([
  "detecting-python",
  "creating-venv",
  "installing-deps",
  "ready",
  "error",
]);
export type WatchdogSetupPhase = z.infer<typeof WatchdogSetupPhaseSchema>;

/** Streamed event during setup so the page can show a live log + phase. */
export const WatchdogSetupProgressSchema = z.object({
  phase: WatchdogSetupPhaseSchema,
  /** One line of pip/venv stdout/stderr, if this event represents log output. */
  line: z.string().optional(),
  /** Terminal message — set when phase is "ready" or "error". */
  message: z.string().optional(),
  python: z
    .object({
      version: z.string(),
      command: z.string(),
    })
    .optional(),
});
export type WatchdogSetupProgress = z.infer<typeof WatchdogSetupProgressSchema>;

export const WatchdogStartResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  status: WatchdogStatusSchema,
});
export type WatchdogStartResult = z.infer<typeof WatchdogStartResultSchema>;

// =============================================================================
// Contracts
// =============================================================================

export const watchdogContracts = {
  getStatus: defineContract({
    channel: "watchdog:get-status",
    input: z.void(),
    output: WatchdogStatusSchema,
  }),
  runSetup: defineContract({
    channel: "watchdog:run-setup",
    input: WatchdogSetupParamsSchema,
    output: WatchdogSetupResultSchema,
  }),
  start: defineContract({
    channel: "watchdog:start",
    input: z.void(),
    output: WatchdogStartResultSchema,
  }),
  stop: defineContract({
    channel: "watchdog:stop",
    input: z.void(),
    output: z.object({ ok: z.boolean() }),
  }),
  uninstall: defineContract({
    channel: "watchdog:uninstall",
    input: z.void(),
    output: z.object({ ok: z.boolean() }),
  }),
  /** Returns the http://host:port base URL the renderer should hit for the
   *  REST CRUD calls. Centralised here so the page never has to hard-code it. */
  getApiBaseUrl: defineContract({
    channel: "watchdog:get-api-base-url",
    input: z.void(),
    output: z.object({ baseUrl: z.string().nullable() }),
  }),
} as const;

export const watchdogClient = createClient(watchdogContracts);

// =============================================================================
// Events (setup progress stream)
// =============================================================================

export const watchdogEvents = {
  setupProgress: defineEvent({
    channel: "watchdog:setup-progress",
    payload: WatchdogSetupProgressSchema,
  }),
  statusChanged: defineEvent({
    channel: "watchdog:status-changed",
    payload: WatchdogStatusSchema,
  }),
} as const;

export const watchdogEventClient = createEventClient(watchdogEvents);
