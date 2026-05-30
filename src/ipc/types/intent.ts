import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

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
  "generate_video",
  "generate_3d_asset",
  "research_news",
  "track_website",
  "track_price",
  "build_app",
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

/** Outcome of executing a single flow step. */
export const StepResultSchema = z.object({
  stepId: z.string(),
  capability: CapabilityIdSchema,
  status: StepStatusSchema,
  /** Structured output from the capability (file paths, mission ids, etc.). */
  output: z.record(z.string(), z.unknown()),
  error: z.string().optional(),
  durationMs: z.number(),
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
});
export type FlowRunResult = z.infer<typeof FlowRunResultSchema>;

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
  phase: z.enum(["plan-code", "assets", "verify"]),
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
} as const;

export const flowClient = createClient(flowContracts);
