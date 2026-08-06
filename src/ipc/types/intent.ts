import { z } from "zod";
import {
  defineContract,
  createClient,
  defineEvent,
  createEventClient,
} from "../contracts/core";
import { FlowArtifactSchema } from "./manifest";

// =============================================================================
// Orion Unification - Intent Bus & Flow Layer (Phase 1)
// =============================================================================
//
// A "command" (typed or spoken) is parsed by an LLM into a structured
// `CommandIntent`: a goal plus an ordered list of capability `steps`. The flow
// runner executes those steps via the capability registry, escalating to the
// Mission System only for heavy multi-file code builds (`build_app`).
//
// This file is the single source of truth for the intent/flow IPC contracts.
// =============================================================================

/**
 * Capabilities the flow runner can dispatch to. These map onto existing
 * OrianBuilder subsystems:
 *  - generate_image/audio/video -> media dispatcher (orchestrator-driven, VRAM aware)
 *  - build_app                  -> escalates to the Mission System
 */
export const CapabilityIdSchema = z.enum([
  "generate_design",
  "generate_image",
  "generate_audio",
  "generate_music",
  "generate_video",
  "generate_3d_asset",
  "research_news",
  "track_website",
  "track_price",
  "build_app",
  "make_game",
  "build_game",
  "edit_scene",
  "process_mesh",
  "run_terminal",
  "edit_files",
  "code_task",
  "run_tests",
  "deploy",
]);
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

/** A single step in a flow: one capability invocation with its inputs. */
export const FlowStepSchema = z.object({
  /** Stable id within the flow, e.g. "hero-image". Used for dependsOn refs. */
  id: z.string(),
  capability: CapabilityIdSchema,
  /** Human-readable description of what this step does. */
  description: z.string().optional(),
  /** Capability-specific input payload. Validated by the capability itself. */
  input: z.record(z.string(), z.unknown()),
  /** Step ids that must complete before this one runs (reserved for parallelism). */
  dependsOn: z.array(z.string()).optional(),
});
export type FlowStep = z.infer<typeof FlowStepSchema>;

/** A fully parsed, executable command. */
export const CommandIntentSchema = z.object({
  /** The user's high-level goal, restated. */
  goal: z.string(),
  /** Ordered steps to satisfy the goal. */
  steps: z.array(FlowStepSchema),
  /** Target app context, when the command operates on an existing app. */
  appId: z.number().optional(),
  /** Optional free-form constraints surfaced to capabilities (style, quality). */
  constraints: z.record(z.string(), z.unknown()).optional(),
});
export type CommandIntent = z.infer<typeof CommandIntentSchema>;

export const StepStatusSchema = z.enum(["success", "failed", "skipped"]);
export type StepStatus = z.infer<typeof StepStatusSchema>;

/** One model load/unload performed while a step ran (swap telemetry). */
export const SwapEventSchema = z.object({
  /**
   * `demote`/`restore` are companion-tier migrations: Marta moving between the
   * GPU and the CPU to make room for a heavy model, without her session ending.
   * They are cheaper than a load/unload pair and are counted separately so swap
   * telemetry does not read as if the orchestrator thrashed.
   */
  kind: z.enum(["load", "unload", "demote", "restore"]),
  /** Model key, e.g. "media:image" or "companion:qwen3.5-4b". */
  key: z.string(),
  durationMs: z.number(),
  /** Free VRAM (MB) measured just before a load; absent for unloads. */
  freeVramMbBefore: z.number().optional(),
});
export type SwapEvent = z.infer<typeof SwapEventSchema>;

/** Outcome of executing a single flow step. */
export const StepResultSchema = z.object({
  stepId: z.string(),
  capability: CapabilityIdSchema,
  status: StepStatusSchema,
  /** Structured output from the capability (file paths, mission ids, etc.). */
  output: z.record(z.string(), z.unknown()),
  error: z.string().optional(),
  durationMs: z.number(),
  /** Model swaps performed while this step ran (absent when none). */
  swaps: z.array(SwapEventSchema).optional(),
  /** Artifacts published by this step onto the run-scoped Harmony bus. */
  artifacts: z.array(FlowArtifactSchema).optional(),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const FlowRunStatusSchema = z.enum(["completed", "failed", "partial"]);
export type FlowRunStatus = z.infer<typeof FlowRunStatusSchema>;

/** Final result of running a whole flow. */
export const FlowRunResultSchema = z.object({
  flowId: z.string(),
  goal: z.string(),
  status: FlowRunStatusSchema,
  steps: z.array(StepResultSchema),
  startedAt: z.number(),
  finishedAt: z.number(),
  /** Aggregated swap cost across all steps (absent when no swaps happened). */
  swapTotals: z.object({ count: z.number(), totalMs: z.number() }).optional(),
  /** Every durable output produced during the run, in publication order. */
  artifacts: z.array(FlowArtifactSchema).default([]),
});
export type FlowRunResult = z.infer<typeof FlowRunResultSchema>;

// =============================================================================
// Flow persistence / resume (Phase 0 hardening)
// =============================================================================

/** Persisted-run status: "running" means the app died mid-flow. */
export const PersistedFlowStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "partial",
]);
export type PersistedFlowStatus = z.infer<typeof PersistedFlowStatusSchema>;

/** Listing entry for a flow run that can be resumed. */
export const ResumableFlowSummarySchema = z.object({
  flowId: z.string(),
  goal: z.string(),
  status: PersistedFlowStatusSchema,
  startedAt: z.number(),
  updatedAt: z.number(),
  totalSteps: z.number(),
  completedSteps: z.number(),
});
export type ResumableFlowSummary = z.infer<typeof ResumableFlowSummarySchema>;

export const ResumeFlowParamsSchema = z.object({ flowId: z.string() });
export type ResumeFlowParams = z.infer<typeof ResumeFlowParamsSchema>;

/** Lightweight descriptor used by the UI to list what the assistant can do. */
export const CapabilityDescriptorSchema = z.object({
  id: CapabilityIdSchema,
  label: z.string(),
  description: z.string(),
});
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

export const ParseCommandParamsSchema = z.object({
  text: z.string().min(1),
  appId: z.number().optional(),
});
export type ParseCommandParams = z.infer<typeof ParseCommandParamsSchema>;

export const RunCommandParamsSchema = z.object({
  text: z.string().min(1),
  appId: z.number().optional(),
});
export type RunCommandParams = z.infer<typeof RunCommandParamsSchema>;

// =============================================================================
// Orchestrated pipeline (Orion conductor) — single prompt → finished product
// =============================================================================

export const RunPipelineParamsSchema = z.object({
  text: z.string().min(1),
  appId: z.number().optional(),
});
export type RunPipelineParams = z.infer<typeof RunPipelineParamsSchema>;

export const PipelinePhaseRecordSchema = z.object({
  phase: z.enum(["download", "plan-code", "assets", "verify"]),
  status: z.enum(["ok", "partial", "failed"]),
  detail: z.string(),
});

/**
 * Result of an orchestrated pipeline run. Carries the phase summary AND a build
 * handoff (`runBuild`/`appId`/`chatId`/`buildGoal`) the renderer uses to launch
 * the Autopilot coding pass against the now-generated assets.
 */
export const PipelineRunResultSchema = z.object({
  buildId: z.string(),
  status: z.enum(["completed", "partial", "failed"]),
  phases: z.array(PipelinePhaseRecordSchema),
  assetSummary: z.object({
    done: z.number(),
    placeholder: z.number(),
    failed: z.number(),
  }),
  verifyAttempts: z.number(),
  /** Absolute paths of assets produced this run (for the build to reference). */
  assetPaths: z.array(z.string()),
  // ── Build handoff (renderer launches Autopilot with these) ──
  runBuild: z.boolean(),
  appId: z.number().optional(),
  chatId: z.number().optional(),
  buildGoal: z.string().optional(),
  reason: z.string().optional(),
});
export type PipelineRunResult = z.infer<typeof PipelineRunResultSchema>;

// =============================================================================
// Direct media generation (single Orion input → media reply rendered in a chat)
// =============================================================================

/** One generated media asset, described so the renderer can build a chat tag
 *  that renders it inline (image/video/audio) via the orian-media:// protocol. */
export const MediaReplyAssetSchema = z.object({
  capability: CapabilityIdSchema,
  /** Coarse media kind the chat renderer switches on. */
  kind: z.enum(["image", "video", "audio", "model"]),
  /** Path of the generated file relative to its app dir (forward slashes),
   *  e.g. ".orianbuilder/media/flow-….png". Absent when generation failed. */
  relativePath: z.string().optional(),
  /** Absolute path on disk (for "open file" affordances). */
  absolutePath: z.string().optional(),
  mimeType: z.string(),
  prompt: z.string(),
  durationMs: z.number().optional(),
  /** Set when this asset could not be generated. */
  error: z.string().optional(),
  /** Route to the setup screen when the backend/runtime needs installing. */
  setupRoute: z.string().optional(),
});
export type MediaReplyAsset = z.infer<typeof MediaReplyAssetSchema>;

export const GenerateMediaParamsSchema = z.object({
  /** A parsed, media-only intent. `appId` (when set) is the app the generated
   *  files are written under so the chat can resolve them by relative path. */
  intent: CommandIntentSchema,
});
export type GenerateMediaParams = z.infer<typeof GenerateMediaParamsSchema>;

export const MediaReplyResultSchema = z.object({
  status: FlowRunStatusSchema,
  assets: z.array(MediaReplyAssetSchema),
});
export type MediaReplyResult = z.infer<typeof MediaReplyResultSchema>;

// =============================================================================
// Contracts
// =============================================================================

export const flowContracts = {
  /** Parse free text into a structured CommandIntent (no execution). */
  parseCommand: defineContract({
    channel: "flow:parse-command",
    input: ParseCommandParamsSchema,
    output: CommandIntentSchema,
  }),
  /** Execute an already-parsed intent. */
  runFlow: defineContract({
    channel: "flow:run",
    input: CommandIntentSchema,
    output: FlowRunResultSchema,
  }),
  /** Convenience: parse text then immediately run it. */
  runCommand: defineContract({
    channel: "flow:run-command",
    input: RunCommandParamsSchema,
    output: FlowRunResultSchema,
  }),
  /** List the capabilities the flow runner currently exposes. */
  listCapabilities: defineContract({
    channel: "flow:list-capabilities",
    input: z.void(),
    output: z.array(CapabilityDescriptorSchema),
  }),
  /**
   * Run the orchestrated pipeline (plan → batch assets → verify) for a single
   * prompt, returning a build handoff for the renderer to launch Autopilot.
   */
  runPipeline: defineContract({
    channel: "flow:run-pipeline",
    input: RunPipelineParamsSchema,
    output: PipelineRunResultSchema,
  }),
  /**
   * Generate the media for a parsed media-only intent using the user's selected
   * model per modality at the device's best settings, and return descriptors the
   * renderer renders inline as a ChatGPT-style reply.
   */
  generateMedia: defineContract({
    channel: "flow:generate-media",
    input: GenerateMediaParamsSchema,
    output: MediaReplyResultSchema,
  }),
  /** List interrupted/partial flow runs that can be resumed. */
  listResumableFlows: defineContract({
    channel: "flow:list-resumable",
    input: z.void(),
    output: z.array(ResumableFlowSummarySchema),
  }),
  /**
   * Resume a persisted flow run: completed steps are kept (their outputs are
   * re-threaded), failed/skipped/unstarted steps are executed again.
   */
  resumeFlow: defineContract({
    channel: "flow:resume",
    input: ResumeFlowParamsSchema,
    output: FlowRunResultSchema,
  }),
} as const;

export const flowClient = createClient(flowContracts);

// =============================================================================
// Pipeline progress events (main → renderer live activity feed)
// =============================================================================

/**
 * One live progress update from a running Orion Factory pipeline. Streamed so
 * the renderer can show, in detail, what is happening: model downloads (incl.
 * raw log lines), phase transitions (plan → assets → verify), and per-asset
 * status — instead of a single static "working…" message.
 */
export const PipelineProgressSchema = z.object({
  /** Build id once the pipeline has started (absent during pre-download). */
  buildId: z.string().optional(),
  kind: z.enum(["download", "phase", "asset", "log", "info"]),
  /** Short headline for the step (e.g. "Generating assets"). */
  label: z.string(),
  /** Optional detail (e.g. a download log line, asset id, error text). */
  detail: z.string().optional(),
  status: z.enum(["running", "ok", "failed", "partial"]).optional(),
});
export type PipelineProgress = z.infer<typeof PipelineProgressSchema>;

export const FlowActivitySchema = z.object({
  flowId: z.string(),
  goal: z.string(),
  stepId: z.string().optional(),
  capability: CapabilityIdSchema.optional(),
  label: z.string(),
  detail: z.string().optional(),
  status: z.enum(["running", "success", "failed", "skipped", "completed"]),
  progress: z.number().min(0).max(100).optional(),
  artifact: FlowArtifactSchema.optional(),
  timestamp: z.number(),
});
export type FlowActivity = z.infer<typeof FlowActivitySchema>;

export const flowEvents = {
  pipelineProgress: defineEvent({
    channel: "flow:pipeline-progress",
    payload: PipelineProgressSchema,
  }),
  /** Generic Harmony activity used by Marta's parallel-work rail. */
  activity: defineEvent({
    channel: "flow:activity",
    payload: FlowActivitySchema,
  }),
} as const;

export const flowEventClient = createEventClient(flowEvents);
