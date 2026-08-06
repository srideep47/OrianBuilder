import { z } from "zod";
import {
  createClient,
  createEventClient,
  createStreamClient,
  defineContract,
  defineEvent,
  defineStream,
} from "../contracts/core";

// =============================================================================
// Marta — the command-center orchestrator
// =============================================================================
//
// P0 exposes only inspection of the capability graph plus the renderer's half
// of the world-state digest. The turn loop, tool invocation and voice arrive in
// later phases; keeping this contract narrow now means the graph can be built
// and verified against the real app before anything can act on it.
// =============================================================================

// ── Graph ────────────────────────────────────────────────────────────────────

export const MartaRiskSchema = z.enum(["low", "medium", "high", "critical"]);

export const MartaStateScopeSchema = z.enum([
  "read_only",
  "workspace",
  "runtime",
  "external",
  "host",
]);

/**
 * JSON Schema is passed through as an opaque record. Mirroring a draft
 * 2020-12 schema in Zod would add a large surface with no benefit: nothing on
 * either side of this boundary interprets it — the renderer displays it and the
 * model consumes it.
 */
const JsonSchemaSchema = z.record(z.string(), z.unknown());

export const MartaActionSchema = z.object({
  id: z.string(),
  domain: z.string(),
  method: z.string(),
  channel: z.string(),
  summary: z.string(),
  risk: MartaRiskSchema,
  stateScope: MartaStateScopeSchema,
  keywords: z.array(z.string()).optional(),
  parameters: JsonSchemaSchema,
  confirm: z.boolean(),
});
export type MartaAction = z.infer<typeof MartaActionSchema>;

export const MartaSurfaceSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  route: z.string(),
  params: JsonSchemaSchema.optional(),
  keywords: z.array(z.string()).optional(),
  displays: z.array(z.string()).optional(),
});
export type MartaSurface = z.infer<typeof MartaSurfaceSchema>;

export const MartaDelegateSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  weight: z.enum(["light", "heavy"]),
  parameters: JsonSchemaSchema,
  keywords: z.array(z.string()).optional(),
});
export type MartaDelegate = z.infer<typeof MartaDelegateSchema>;

export const MartaGraphSummarySchema = z.object({
  actions: z.array(MartaActionSchema),
  surfaces: z.array(MartaSurfaceSchema),
  delegates: z.array(MartaDelegateSchema),
  /** Contracts the app defines but Marta is not granted. Diagnostic only. */
  unregistered: z.array(z.string()),
  /** Registry entries naming contracts that no longer exist. Should be empty. */
  orphaned: z.array(z.string()),
  /** Total invoke contracts the app defines, granted or not. */
  totalContracts: z.number(),
});
export type MartaGraphSummary = z.infer<typeof MartaGraphSummarySchema>;

// ── Stage state (renderer → main) ────────────────────────────────────────────

export const MartaStageStateSchema = z.object({
  surfaceId: z.string().nullable(),
  params: z.record(z.string(), z.unknown()).optional(),
  alsoShowing: z.array(z.string()).optional(),
  /**
   * The project the user is working in. Pushed with the stage rather than
   * looked up in main, because "active" is a fact about what is on screen —
   * main's notion of a selected app can lag or differ.
   */
  activeProject: z
    .object({
      id: z.number(),
      name: z.string(),
    })
    .nullable()
    .optional(),
});
export type MartaStageState = z.infer<typeof MartaStageStateSchema>;

// ── World state ──────────────────────────────────────────────────────────────

export const MartaWorldStateSchema = z.object({
  stage: MartaStageStateSchema,
  project: z
    .object({
      id: z.number(),
      name: z.string(),
      path: z.string().optional(),
      running: z.boolean().optional(),
      branch: z.string().optional(),
      uncommittedFiles: z.number().optional(),
    })
    .nullable(),
  resident: z
    .object({
      kind: z.string(),
      modelId: z.string(),
      vramMb: z.number(),
    })
    .nullable(),
  companion: z
    .object({
      modelId: z.string(),
      placement: z.enum(["gpu", "cpu"]),
      thrashLatched: z.boolean().optional(),
    })
    .nullable(),
  freeVramMb: z.number().nullable(),
  totalVramMb: z.number().nullable(),
  gpu: z.string().nullable(),
  running: z.array(
    z.object({
      kind: z.enum([
        "flow",
        "mission",
        "media",
        "download",
        "terminal",
        "claude",
        "local",
      ]),
      id: z.string(),
      label: z.string(),
      progress: z.number().optional(),
      awaitingUser: z.boolean().optional(),
    }),
  ),
  recentArtifacts: z.array(
    z.object({
      kind: z.string(),
      label: z.string(),
      path: z.string().optional(),
    }),
  ),
  degraded: z.array(z.string()),
});
export type MartaWorldState = z.infer<typeof MartaWorldStateSchema>;

// ── Residency ────────────────────────────────────────────────────────────────

export const MartaTierIdSchema = z.enum([
  "omni",
  "4b",
  "2b",
  "0.8b",
  "cpu-only",
]);
export type MartaTierId = z.infer<typeof MartaTierIdSchema>;

export const MartaResidencySchema = z.object({
  plan: z
    .object({
      tierId: MartaTierIdSchema,
      modelId: z.string(),
      label: z.string(),
      vramMb: z.number(),
      placement: z.enum(["gpu", "cpu"]),
      speechNative: z.boolean(),
      rationale: z.string(),
    })
    .nullable(),
  /** Where she actually is now, which can differ from the plan under pressure. */
  placement: z.enum(["gpu", "cpu"]).nullable(),
  /** GPU→CPU migrations inside the recent window. */
  recentDemotions: z.number(),
  thrashLatched: z.boolean(),
  /** Total usable VRAM the gate is budgeting against; null when unknown. */
  budgetMb: z.number().nullable(),
});
export type MartaResidency = z.infer<typeof MartaResidencySchema>;

// ── Turns ────────────────────────────────────────────────────────────────────

/**
 * One thing that happened during a turn.
 *
 * A discriminated union rather than separate channels: the renderer renders
 * these in order, and ordering across several channels is not guaranteed —
 * a `done` could overtake the `tool-end` that preceded it.
 */
export const MartaTurnEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thinking") }),
  z.object({
    kind: z.literal("tool-start"),
    id: z.string(),
    label: z.string(),
    needsApproval: z.boolean(),
  }),
  z.object({
    kind: z.literal("tool-end"),
    id: z.string(),
    ok: z.boolean(),
    detail: z.string(),
  }),
  z.object({
    kind: z.literal("surface"),
    surfaceId: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("delegation-choice"),
    requestId: z.string(),
    appId: z.number(),
    goal: z.string(),
    readOnly: z.boolean(),
  }),
  z.object({ kind: z.literal("text-delta"), text: z.string().min(1) }),
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({
    kind: z.literal("done"),
    text: z.string(),
    rounds: z.number(),
    durationMs: z.number(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type MartaTurnEvent = z.infer<typeof MartaTurnEventSchema>;

export const MartaModelStatusSchema = z.object({
  running: z.boolean(),
  modelId: z.string().nullable(),
  modelPath: z.string().nullable(),
  placement: z.enum(["gpu", "cpu"]).nullable(),
  port: z.number().nullable(),
  lastError: z.string().nullable(),
});
export type MartaModelStatus = z.infer<typeof MartaModelStatusSchema>;

// ── Delegation preferences and supervised work ─────────────────────────────

export const MartaCodingWorkerSchema = z.enum(["ask", "local", "claude"]);
export type MartaCodingWorker = z.infer<typeof MartaCodingWorkerSchema>;

export const MartaDelegationSelectionSchema = z.object({
  worker: z.enum(["local", "claude"]),
  /** Provider-qualified local model, e.g. `lmstudio:qwen3-coder`. */
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** Persist this as the default instead of asking on the next coding task. */
  remember: z.boolean().optional(),
});
export type MartaDelegationSelection = z.infer<
  typeof MartaDelegationSelectionSchema
>;

export const MartaDelegationConversationSchema = z.object({
  worker: z.enum(["local", "claude"]).optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  remember: z.boolean().optional(),
});
export type MartaDelegationConversation = z.infer<
  typeof MartaDelegationConversationSchema
>;

export const MartaPendingDelegationSchema = z.object({
  requestId: z.string(),
  appId: z.number(),
  goal: z.string(),
  readOnly: z.boolean(),
  conversation: MartaDelegationConversationSchema.optional(),
});
export type MartaPendingDelegation = z.infer<
  typeof MartaPendingDelegationSchema
>;

/**
 * How much Marta reports without being asked.
 *
 * `quiet` still speaks critical failures — it is a request for less chatter, not
 * a request to be left in the dark about a build that just died.
 */
export const MartaNarrationDetailSchema = z.enum([
  "quiet",
  "normal",
  "detailed",
]);
export type MartaNarrationDetail = z.infer<typeof MartaNarrationDetailSchema>;

export const MartaPreferencesSchema = z.object({
  codingWorker: MartaCodingWorkerSchema,
  localModel: z.string().nullable(),
  claudeModel: z.string().nullable(),
  claudeEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable(),
  narrationDetail: MartaNarrationDetailSchema,
});
export type MartaPreferences = z.infer<typeof MartaPreferencesSchema>;

export const MartaTaskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);
export type MartaTaskStatus = z.infer<typeof MartaTaskStatusSchema>;

export const MartaEvidenceSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "file",
    "diff",
    "build",
    "test",
    "preview",
    "screenshot",
    "artifact",
    "log",
    "health",
  ]),
  label: z.string(),
  ok: z.boolean().optional(),
  uri: z.string().optional(),
  path: z.string().optional(),
  detail: z.string().optional(),
  timestamp: z.number(),
});
export type MartaEvidence = z.infer<typeof MartaEvidenceSchema>;

export const MartaCodingAcceptanceCheckSchema = z.enum([
  "build",
  "typecheck",
  "test",
  "preview",
  "visual",
]);
export type MartaCodingAcceptanceCheck = z.infer<
  typeof MartaCodingAcceptanceCheckSchema
>;

export const MartaCodingTaskAcceptanceTargetSchema = z.object({
  goal: z.string(),
  projectRoot: z.string().optional(),
  targetPaths: z.array(z.string()),
  readOnly: z.boolean(),
  requireChangedFiles: z.boolean(),
  requiredChecks: z.array(MartaCodingAcceptanceCheckSchema),
});
export type MartaCodingTaskAcceptanceTarget = z.infer<
  typeof MartaCodingTaskAcceptanceTargetSchema
>;

export const MartaCodingTaskFileSnapshotEntrySchema = z.object({
  size: z.number().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  digest: z.string(),
});
export const MartaCodingTaskFileSnapshotSchema = z.object({
  capturedAt: z.number(),
  files: z.record(z.string(), MartaCodingTaskFileSnapshotEntrySchema),
});
export type MartaCodingTaskFileSnapshot = z.infer<
  typeof MartaCodingTaskFileSnapshotSchema
>;

export const MartaCodingTaskCheckEvidenceSchema = z.object({
  check: MartaCodingAcceptanceCheckSchema,
  status: z.enum(["passed", "failed", "skipped"]),
  source: z.enum(["orion", "worker"]),
  command: z.string().optional(),
  artifact: z.string().optional(),
  detail: z.string().optional(),
  observedAt: z.number().optional(),
});
export type MartaCodingTaskCheckEvidence = z.infer<
  typeof MartaCodingTaskCheckEvidenceSchema
>;

export const MartaCodingTaskAcceptanceEvidenceSchema = z.object({
  workerReportedSuccess: z.boolean(),
  observedChangedFiles: z.array(z.string()),
  checks: z.array(MartaCodingTaskCheckEvidenceSchema),
});
export type MartaCodingTaskAcceptanceEvidence = z.infer<
  typeof MartaCodingTaskAcceptanceEvidenceSchema
>;

export const MartaCodingTaskAcceptanceDecisionSchema = z.object({
  accepted: z.boolean(),
  status: z.enum(["accepted", "pending-evidence", "failed"]),
  relevantChangedFiles: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  failedChecks: z.array(MartaCodingAcceptanceCheckSchema),
});
export type MartaCodingTaskAcceptanceDecision = z.infer<
  typeof MartaCodingTaskAcceptanceDecisionSchema
>;

export const MartaResourceSnapshotSchema = z.object({
  cpuPercent: z.number().optional(),
  ramMb: z.number().optional(),
  gpuPercent: z.number().optional(),
  vramMb: z.number().optional(),
  powerWatts: z.number().optional(),
});
export type MartaResourceSnapshot = z.infer<typeof MartaResourceSnapshotSchema>;

export const MartaTaskSchema = z.object({
  id: z.string(),
  runtimeId: z.string().optional(),
  kind: z.enum(["claude", "local", "flow", "mission"]),
  title: z.string(),
  goal: z.string(),
  appId: z.number().optional(),
  projectName: z.string().optional(),
  workerLabel: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  status: MartaTaskStatusSchema,
  phase: z.string().optional(),
  goalId: z.string().optional(),
  workstreamId: z.string().optional(),
  priority: z.number().optional(),
  progress: z.number().min(0).max(1).optional(),
  activeTool: z.string().optional(),
  activeFile: z.string().optional(),
  previewUrl: z.string().optional(),
  terminalTail: z.array(z.string()).max(50).optional(),
  testSummary: z.string().optional(),
  blockedReason: z.string().optional(),
  requiresAttention: z.boolean().optional(),
  attempt: z.number().int().nonnegative().optional(),
  maxAttempts: z.number().int().positive().optional(),
  lastHeartbeatAt: z.number().optional(),
  startedAt: z.number().optional(),
  evidence: z.array(MartaEvidenceSchema).optional(),
  acceptanceTarget: MartaCodingTaskAcceptanceTargetSchema.optional(),
  acceptanceBaseline: MartaCodingTaskFileSnapshotSchema.optional(),
  acceptanceEvidence: MartaCodingTaskAcceptanceEvidenceSchema.optional(),
  acceptanceDecision: MartaCodingTaskAcceptanceDecisionSchema.optional(),
  resourceUsage: MartaResourceSnapshotSchema.optional(),
  completedSteps: z.number(),
  costUsd: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  error: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
});
export type MartaTask = z.infer<typeof MartaTaskSchema>;

export const MartaTaskEventTypeSchema = z.enum([
  "created",
  "queued",
  "started",
  "heartbeat",
  "checkpoint",
  "artifact",
  "blocked",
  "failed",
  "retrying",
  "verifying",
  "succeeded",
  "cancelled",
  "resource",
  "layout",
]);
export type MartaTaskEventType = z.infer<typeof MartaTaskEventTypeSchema>;

export const MartaTaskEventSchema = z.object({
  eventId: z.string(),
  timestamp: z.number(),
  taskId: z.string(),
  goalId: z.string().optional(),
  workstreamId: z.string().optional(),
  attempt: z.number().int().nonnegative().optional(),
  parentEventId: z.string().optional(),
  actor: z.string(),
  type: MartaTaskEventTypeSchema,
  status: MartaTaskStatusSchema.optional(),
  phase: z.string().optional(),
  progress: z.number().min(0).max(1).optional(),
  publicSummary: z.string(),
  evidence: z.array(MartaEvidenceSchema).optional(),
  resourceUsage: MartaResourceSnapshotSchema.optional(),
});
export type MartaTaskEvent = z.infer<typeof MartaTaskEventSchema>;

export const MartaGoalNodeDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["action", "delegate", "verification"]),
  operation: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  dependencies: z.array(z.string()).optional(),
  resources: z.array(z.string()).optional(),
  priority: z.number().optional(),
  maxAttempts: z.number().int().positive().max(5).optional(),
  reversible: z.boolean().optional(),
});

export const MartaGoalNodeStateSchema = MartaGoalNodeDefinitionSchema.extend({
  status: z.enum([
    "queued",
    "waiting",
    "running",
    "verifying",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  attempt: z.number().int().nonnegative(),
  priority: z.number(),
  phase: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  waitingFor: z.array(z.string()).optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
});

export const MartaGoalSnapshotSchema = z.object({
  id: z.string(),
  title: z.string(),
  userRequest: z.string(),
  status: z.enum([
    "queued",
    "running",
    "paused",
    "succeeded",
    "failed",
    "cancelled",
  ]),
  maxConcurrency: z.number().int().positive(),
  nodes: z.array(MartaGoalNodeStateSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
});
export type MartaGoalSnapshot = z.infer<typeof MartaGoalSnapshotSchema>;

// ── Contracts ────────────────────────────────────────────────────────────────

export const martaContracts = {
  /**
   * The whole graph. Backs the command palette (which resolves through the
   * same nodes Marta does, so keyboard and voice never diverge) and the
   * diagnostics view.
   */
  getGraph: defineContract({
    channel: "marta:get-graph",
    input: z.void(),
    output: MartaGraphSummarySchema,
  }),

  /** The actions that would be offered for a given utterance. */
  retrieve: defineContract({
    channel: "marta:retrieve",
    input: z.object({
      query: z.string(),
      limit: z.number().int().positive().max(128).optional(),
    }),
    output: z.object({ actions: z.array(MartaActionSchema) }),
  }),

  /** The current digest, plus the rendered text Marta actually sees. */
  getWorldState: defineContract({
    channel: "marta:get-world-state",
    input: z.void(),
    output: z.object({
      state: MartaWorldStateSchema,
      rendered: z.string(),
    }),
  }),

  /**
   * The renderer tells main what is on the Stage. Main cannot ask for this
   * synchronously, and the digest needs it every turn, so it is pushed on
   * change rather than pulled.
   */
  setStageState: defineContract({
    channel: "marta:set-stage-state",
    input: MartaStageStateSchema,
    output: z.object({ ok: z.literal(true) }),
  }),

  /**
   * Marta's GPU residency: which rung of the model ladder this machine gets,
   * where she is placed, and whether she is holding off the card to avoid
   * migration thrash. Backs the Engine surface's diagnostics.
   */
  getResidency: defineContract({
    channel: "marta:get-residency",
    input: z.void(),
    output: MartaResidencySchema,
  }),

  /** Is her model up, and where. */
  getModelStatus: defineContract({
    channel: "marta:model-status",
    input: z.void(),
    output: MartaModelStatusSchema,
  }),

  /** Bring her up on the tier this machine's hardware selected. */
  startModel: defineContract({
    channel: "marta:start-model",
    input: z.void(),
    output: MartaModelStatusSchema,
  }),

  /** Shut her down and give the VRAM back. */
  stopModel: defineContract({
    channel: "marta:stop-model",
    input: z.void(),
    output: MartaModelStatusSchema,
  }),

  /**
   * Move her between the GPU and the CPU by hand.
   *
   * A real user control — "get off my GPU, I need it" is a reasonable thing to
   * want before a long render — and the only way to exercise a demotion
   * without installing a 12GB pipeline. Setting `cpu` is a *preference*, so the
   * gate will not undo it when the card frees up; setting `gpu` hands the
   * decision back to the residency policy.
   */
  setPlacement: defineContract({
    channel: "marta:set-placement",
    input: z.object({ placement: z.enum(["gpu", "cpu"]) }),
    output: MartaModelStatusSchema,
  }),

  /**
   * Run one turn.
   *
   * Returns the whole event list rather than streaming it. Every event is
   * already whole — a tool result is not partial — and the only thing worth
   * streaming is token-by-token narration, which arrives with the voice bus and
   * will need a real stream contract then. Until then this keeps the renderer
   * a single `await`.
   */
  sendTurn: defineContract({
    channel: "marta:send-turn",
    input: z.object({
      text: z.string().min(1),
      /**
       * Action ids the user approved for *this* turn. Approval is never
       * ambient: saying yes to deleting one file must not authorise deleting
       * another later.
       */
      approvedActions: z.array(z.string()).optional(),
      delegationSelection: MartaDelegationSelectionSchema.optional(),
    }),
    output: z.object({
      text: z.string(),
      events: z.array(MartaTurnEventSchema),
    }),
  }),

  /**
   * Stop the one active Marta turn.
   *
   * This is deliberately separate from the renderer's local cancellation: a
   * barge-in has to abort the llama-server request as well, otherwise the old
   * answer can monopolise the single model slot while the user is already
   * speaking their replacement request.
   */
  cancelActiveTurn: defineContract({
    channel: "marta:cancel-active-turn",
    input: z.void(),
    output: z.object({ cancelled: z.boolean() }),
  }),

  /** The conversation so far, for rehydrating the transcript. */
  getTranscript: defineContract({
    channel: "marta:get-transcript",
    input: z.void(),
    output: z.object({
      messages: z.array(
        z.object({
          role: z.enum(["system", "user", "assistant", "tool"]),
          content: z.string(),
        }),
      ),
    }),
  }),

  clearTranscript: defineContract({
    channel: "marta:clear-transcript",
    input: z.void(),
    output: z.object({ ok: z.literal(true) }),
  }),

  /** Persistent provider/model defaults used by coding delegation. */
  getPreferences: defineContract({
    channel: "marta:get-preferences",
    input: z.void(),
    output: MartaPreferencesSchema,
  }),

  setPreferences: defineContract({
    channel: "marta:set-preferences",
    input: MartaPreferencesSchema.partial(),
    output: MartaPreferencesSchema,
  }),

  /**
   * Start a coding delegation after the user has made the explicit worker
   * choice. This bypasses another companion-model round: once the user has
   * chosen, a small model must not be allowed to ask the same question again.
   */
  startDelegation: defineContract({
    channel: "marta:start-delegation",
    input: z.object({
      requestId: z.string(),
      appId: z.number(),
      goal: z.string().min(1),
      readOnly: z.boolean(),
      /** The typed or spoken choice, retained in Marta's durable transcript. */
      userReply: z.string().min(1).optional(),
      selection: MartaDelegationSelectionSchema,
    }),
    output: z.object({
      ok: z.boolean(),
      summary: z.string(),
      taskId: z.string().optional(),
    }),
  }),

  /** Persist deterministic conversational replies that do not need an LLM turn. */
  appendConversation: defineContract({
    channel: "marta:append-conversation",
    input: z.object({
      user: z.string().min(1),
      assistant: z.string().min(1),
    }),
    output: z.object({ ok: z.literal(true) }),
  }),

  /** Restore an unfinished worker/model question after a renderer/app restart. */
  getPendingDelegation: defineContract({
    channel: "marta:get-pending-delegation",
    input: z.void(),
    output: z.object({ pending: MartaPendingDelegationSchema.nullable() }),
  }),

  setPendingDelegation: defineContract({
    channel: "marta:set-pending-delegation",
    input: z.object({ pending: MartaPendingDelegationSchema.nullable() }),
    output: z.object({ ok: z.literal(true) }),
  }),

  /** Unified work ledger across Claude, local agents, flows and missions. */
  listTasks: defineContract({
    channel: "marta:list-tasks",
    input: z
      .object({
        includeCompleted: z.boolean().optional(),
        limit: z.number().int().positive().max(100).optional(),
      })
      .optional(),
    output: z.object({ tasks: z.array(MartaTaskSchema) }),
  }),

  /** Append-only execution history used by Marta, the Stage and restart recovery. */
  listTaskEvents: defineContract({
    channel: "marta:list-task-events",
    input: z
      .object({
        taskId: z.string().optional(),
        goalId: z.string().optional(),
        after: z.number().optional(),
        limit: z.number().int().positive().max(2_000).optional(),
      })
      .optional(),
    output: z.object({ events: z.array(MartaTaskEventSchema) }),
  }),

  /**
   * Stop, retry or reprioritise one entry in the ledger.
   *
   * Deliberately one contract rather than a renderer that knows how to cancel a
   * Claude turn, a mission and a goal node. "Stop task two" is one user
   * intention; which subsystem owns the cancellation is main's problem, and
   * spreading that knowledge into the Stage is how the three drift apart.
   */
  controlTask: defineContract({
    channel: "marta:control-task",
    input: z.discriminatedUnion("action", [
      z.object({ taskId: z.string(), action: z.literal("stop") }),
      z.object({ taskId: z.string(), action: z.literal("retry") }),
      z.object({
        taskId: z.string(),
        action: z.literal("prioritize"),
        priority: z.number(),
      }),
    ]),
    output: z.object({ ok: z.boolean(), summary: z.string() }),
  }),

  createGoal: defineContract({
    channel: "marta:create-goal",
    input: z.object({
      id: z.string().optional(),
      title: z.string().min(1),
      userRequest: z.string().min(1),
      maxConcurrency: z.number().int().positive().max(16).optional(),
      nodes: z.array(MartaGoalNodeDefinitionSchema).min(1),
      start: z.boolean().optional(),
    }),
    output: MartaGoalSnapshotSchema,
  }),

  listGoals: defineContract({
    channel: "marta:list-goals",
    input: z.void(),
    output: z.object({ goals: z.array(MartaGoalSnapshotSchema) }),
  }),

  controlGoal: defineContract({
    channel: "marta:control-goal",
    input: z.discriminatedUnion("action", [
      z.object({ goalId: z.string(), action: z.literal("pause") }),
      z.object({ goalId: z.string(), action: z.literal("resume") }),
      z.object({ goalId: z.string(), action: z.literal("cancel") }),
      z.object({
        goalId: z.string(),
        action: z.literal("prioritize"),
        nodeId: z.string(),
        priority: z.number(),
      }),
      z.object({
        goalId: z.string(),
        action: z.literal("cancel-node"),
        nodeId: z.string(),
      }),
    ]),
    output: MartaGoalSnapshotSchema,
  }),
} as const;

export const martaClient = createClient(martaContracts);

/**
 * One live Marta turn.  Token fragments use the same typed stream machinery
 * as chat so the main process can cancel the actual llama-server request while
 * the renderer starts TTS on the first complete sentence.
 */
export const martaTurnStreamContract = defineStream({
  channel: "marta:stream-turn",
  input: z.object({
    turnId: z.string().uuid(),
    text: z.string().min(1),
    approvedActions: z.array(z.string()).optional(),
    delegationSelection: MartaDelegationSelectionSchema.optional(),
  }),
  keyField: "turnId",
  events: {
    chunk: {
      channel: "marta:turn:chunk",
      payload: z.object({
        turnId: z.string().uuid(),
        event: MartaTurnEventSchema,
      }),
    },
    end: {
      channel: "marta:turn:end",
      payload: z.object({ turnId: z.string().uuid(), text: z.string() }),
    },
    error: {
      channel: "marta:turn:error",
      payload: z.object({ turnId: z.string().uuid(), error: z.string() }),
    },
  },
});

export const martaTurnStreamClient = createStreamClient(
  martaTurnStreamContract,
);

export const martaEvents = {
  taskUpdate: defineEvent({
    channel: "marta:task-update",
    payload: MartaTaskSchema,
  }),
  taskEvent: defineEvent({
    channel: "marta:task-event",
    payload: MartaTaskEventSchema,
  }),
  proactiveNarration: defineEvent({
    channel: "marta:proactive-narration",
    payload: z.object({
      id: z.string(),
      timestamp: z.number(),
      priority: z.enum(["quiet", "normal", "critical"]),
      text: z.string(),
      taskIds: z.array(z.string()),
      speak: z.boolean(),
    }),
  }),
  delegationChoice: defineEvent({
    channel: "marta:delegation-choice",
    payload: z.object({
      requestId: z.string(),
      appId: z.number(),
      goal: z.string(),
      readOnly: z.boolean(),
    }),
  }),
} as const;

export const martaEventClient = createEventClient(martaEvents);
