import { z } from "zod";
import {
  defineContract,
  defineEvent,
  createClient,
  createEventClient,
} from "../contracts/core";

// =============================================================================
// Orion Setup — one-click, resumable provisioning of everything the auto
// content-creation pipeline needs (media backend + ffmpeg, the user's selected
// media models, the local LLM Engine, and P2P pairing).
// =============================================================================
//
// The work itself lives in a persisted main-process orchestrator
// (see main/orion_setup/orchestrator.ts) modelled on the media queue: state is
// written to disk after every transition so a setup that dies mid-download
// (renderer reload, app restart, dropped internet) resumes from where it left
// off instead of starting over. The renderer subscribes to `progress` events
// for a live view and seeds from `getState`.
// =============================================================================

/** The ordered steps of a full Orion setup. */
export const OrionSetupStepIdSchema = z.enum([
  /** Detect GPU + best media backend (cuda/directml/rocm/metal/cpu). */
  "hardware",
  /** Create the Python venv + install GPU-matched libraries (incl. ffmpeg). */
  "media-deps",
  /** Download the weights for the user's selected media models. */
  "media-models",
  /** Start the media backend and wait until it answers health checks. */
  "start-backend",
  /** Optional: a local GGUF language model for free-form scripts + offline agent. */
  "engine-model",
  /** Optional: join the Orion network so teammates' machines can share compute. */
  "p2p",
]);
export type OrionSetupStepId = z.infer<typeof OrionSetupStepIdSchema>;

export const OrionSetupStepStatusSchema = z.enum([
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
  /** Done as far as automation can take it; needs a human (pick a model, pair a
   *  device). Never blocks "Orion is ready" — these steps are always optional. */
  "needs-action",
]);
export type OrionSetupStepStatus = z.infer<typeof OrionSetupStepStatusSchema>;

export const OrionSetupStepSchema = z.object({
  id: OrionSetupStepIdSchema,
  label: z.string(),
  status: OrionSetupStepStatusSchema,
  /** When true, this step must reach `done`/`skipped` for overall completion. */
  required: z.boolean(),
  /** Short human status line (current sub-action, GPU label, error summary). */
  detail: z.string().optional(),
  /** 0–100 while a long operation (a download) reports progress. */
  percent: z.number().min(0).max(100).optional(),
  error: z.string().optional(),
  /** For `needs-action` steps: an in-app route the panel deep-links to. */
  actionRoute: z.string().optional(),
});
export type OrionSetupStep = z.infer<typeof OrionSetupStepSchema>;

export const OrionSetupOverallSchema = z.enum([
  /** Never started on this machine. */
  "idle",
  /** A step is actively running. */
  "running",
  /** Stopped before all required steps finished (failure or cancel) — resumable. */
  "paused",
  /** Every required step is done/skipped; Orion can run content jobs. */
  "completed",
]);
export type OrionSetupOverall = z.infer<typeof OrionSetupOverallSchema>;

export const OrionSetupStateSchema = z.object({
  overall: OrionSetupOverallSchema,
  steps: z.array(OrionSetupStepSchema),
  includeEngine: z.boolean(),
  includeP2p: z.boolean(),
  /** Detected GPU + backend, e.g. "RTX 4080 Super · cuda". */
  hardwareSummary: z.string().optional(),
  /** Resolved media backend id, persisted so a resume can install without
   *  re-running hardware detection. */
  backend: z.string().optional(),
  startedAt: z.number().optional(),
  updatedAt: z.number().optional(),
  /** Recent activity lines (capped) for the live feed. */
  log: z.array(z.string()),
});
export type OrionSetupState = z.infer<typeof OrionSetupStateSchema>;

export const StartOrionSetupParamsSchema = z.object({
  includeEngine: z.boolean().default(true),
  includeP2p: z.boolean().default(true),
});
export type StartOrionSetupParams = z.infer<typeof StartOrionSetupParamsSchema>;

export const OrionSetupStepParamsSchema = z.object({
  stepId: OrionSetupStepIdSchema,
});

export const orionSetupContracts = {
  getState: defineContract({
    channel: "orion-setup:get-state",
    input: z.void(),
    output: OrionSetupStateSchema,
  }),
  start: defineContract({
    channel: "orion-setup:start",
    input: StartOrionSetupParamsSchema,
    output: OrionSetupStateSchema,
  }),
  resume: defineContract({
    channel: "orion-setup:resume",
    input: z.void(),
    output: OrionSetupStateSchema,
  }),
  cancel: defineContract({
    channel: "orion-setup:cancel",
    input: z.void(),
    output: OrionSetupStateSchema,
  }),
  retryStep: defineContract({
    channel: "orion-setup:retry-step",
    input: OrionSetupStepParamsSchema,
    output: OrionSetupStateSchema,
  }),
  skipStep: defineContract({
    channel: "orion-setup:skip-step",
    input: OrionSetupStepParamsSchema,
    output: OrionSetupStateSchema,
  }),
} as const;

export const orionSetupClient = createClient(orionSetupContracts);

export const orionSetupEvents = {
  progress: defineEvent({
    channel: "orion-setup:progress",
    payload: OrionSetupStateSchema,
  }),
} as const;

export const orionSetupEventClient = createEventClient(orionSetupEvents);
