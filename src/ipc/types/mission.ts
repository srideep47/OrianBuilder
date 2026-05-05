import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

export const MissionStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const MissionAutonomyProfileSchema = z.enum([
  "supervised",
  "trusted-workspace",
  "full-autopilot-sandbox",
]);

export type MissionAutonomyProfile = z.infer<
  typeof MissionAutonomyProfileSchema
>;

export const MissionSchema = z.object({
  id: z.number(),
  appId: z.number(),
  chatId: z.number().nullable(),
  title: z.string(),
  goal: z.string(),
  status: MissionStatusSchema,
  autonomyProfile: MissionAutonomyProfileSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
  startedAt: z.date().nullable(),
  completedAt: z.date().nullable(),
});

export type Mission = z.infer<typeof MissionSchema>;

export const MissionEventSchema = z.object({
  id: z.number(),
  missionId: z.number(),
  eventType: z.string(),
  summary: z.string(),
  body: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.date(),
});

export type MissionEvent = z.infer<typeof MissionEventSchema>;

export const MissionTaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
]);

export const MissionTaskSchema = z.object({
  id: z.number(),
  missionId: z.number(),
  externalId: z.string(),
  title: z.string(),
  status: MissionTaskStatusSchema,
  orderIndex: z.number(),
  createdAt: z.date(),
  updatedAt: z.date(),
  completedAt: z.date().nullable(),
});

export type MissionTask = z.infer<typeof MissionTaskSchema>;

export const MissionRunStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const MissionRunSchema = z.object({
  id: z.number(),
  missionId: z.number(),
  chatId: z.number().nullable(),
  messageId: z.number().nullable(),
  status: MissionRunStatusSchema,
  model: z.string().nullable(),
  requestId: z.string().nullable(),
  totalStepsExecuted: z.number(),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  startedAt: z.date(),
  completedAt: z.date().nullable(),
});

export type MissionRun = z.infer<typeof MissionRunSchema>;

export const MissionWorkerRoleSchema = z.enum([
  "planner",
  "architect",
  "builder",
  "qa",
  "reviewer",
  "integrator",
]);

export const MissionWorkerStatusSchema = z.enum([
  "queued",
  "ready",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);

export const MissionWorkerWorkspaceProviderSchema = z.enum([
  "local",
  "worktree",
  "docker",
  "cloud",
]);

export const MissionWorkerSchema = z.object({
  id: z.number(),
  missionId: z.number(),
  runId: z.number().nullable(),
  workerKey: z.string(),
  role: MissionWorkerRoleSchema,
  status: MissionWorkerStatusSchema,
  title: z.string(),
  goal: z.string(),
  workspaceProvider: MissionWorkerWorkspaceProviderSchema,
  workspaceRef: z.string().nullable(),
  branchName: z.string().nullable(),
  fileScopes: z.array(z.string()).nullable(),
  dependsOn: z.array(z.string()).nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  startedAt: z.date().nullable(),
  completedAt: z.date().nullable(),
});

export type MissionWorker = z.infer<typeof MissionWorkerSchema>;

export const MissionCheckpointSchema = z.object({
  id: z.number(),
  missionId: z.number(),
  runId: z.number().nullable(),
  summary: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.date(),
});

export type MissionCheckpoint = z.infer<typeof MissionCheckpointSchema>;

export const MissionArtifactTypeSchema = z.enum([
  "screenshot",
  "accessibility_tree",
  "console_output",
  "runtime",
]);

export const MissionArtifactSchema = z.object({
  id: z.number(),
  missionId: z.number(),
  runId: z.number().nullable(),
  artifactType: MissionArtifactTypeSchema,
  title: z.string(),
  uri: z.string().nullable(),
  body: z.string().nullable(),
  mimeType: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.date(),
});

export type MissionArtifact = z.infer<typeof MissionArtifactSchema>;

export const CreateMissionParamsSchema = z.object({
  appId: z.number(),
  chatId: z.number().optional(),
  title: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  autonomyProfile: MissionAutonomyProfileSchema.optional(),
});

export type CreateMissionParams = z.infer<typeof CreateMissionParamsSchema>;

export const UpdateMissionStatusParamsSchema = z.object({
  missionId: z.number(),
  status: MissionStatusSchema,
  waiveIncompleteGates: z.boolean().optional(),
  waiverReason: z.string().trim().optional(),
});

export type UpdateMissionStatusParams = z.infer<
  typeof UpdateMissionStatusParamsSchema
>;

export const AddMissionEventParamsSchema = z.object({
  missionId: z.number(),
  eventType: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  body: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type AddMissionEventParams = z.infer<typeof AddMissionEventParamsSchema>;

export const CreateMissionWorkerParamsSchema = z.object({
  missionId: z.number(),
  workerKey: z.string().trim().min(1),
  role: MissionWorkerRoleSchema,
  title: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  workspaceProvider: MissionWorkerWorkspaceProviderSchema.optional(),
  workspaceRef: z.string().trim().nullable().optional(),
  branchName: z.string().trim().nullable().optional(),
  fileScopes: z.array(z.string().trim().min(1)).nullable().optional(),
  dependsOn: z.array(z.string().trim().min(1)).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type CreateMissionWorkerParams = z.infer<
  typeof CreateMissionWorkerParamsSchema
>;

export const UpdateMissionWorkerStatusParamsSchema = z.object({
  workerId: z.number(),
  status: MissionWorkerStatusSchema,
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type UpdateMissionWorkerStatusParams = z.infer<
  typeof UpdateMissionWorkerStatusParamsSchema
>;

export const MissionWorkerReportSchema = z.object({
  summary: z.string().trim().min(1),
  changedFiles: z.array(z.string().trim().min(1)).default([]),
  validation: z.string().trim().nullable().optional(),
  blockers: z.string().trim().nullable().optional(),
  artifacts: z.array(z.string().trim().min(1)).default([]),
});

export type MissionWorkerReport = z.infer<typeof MissionWorkerReportSchema>;

export const DispatchMissionWorkersParamsSchema = z.object({
  missionId: z.number(),
  status: z.enum(["ready", "running"]).optional().default("ready"),
});

export type DispatchMissionWorkersParams = z.infer<
  typeof DispatchMissionWorkersParamsSchema
>;

export const RetryMissionWorkerParamsSchema = z.object({
  workerId: z.number(),
  reason: z.string().trim().optional(),
});

export type RetryMissionWorkerParams = z.infer<
  typeof RetryMissionWorkerParamsSchema
>;

export const MarkStaleMissionWorkersParamsSchema = z.object({
  missionId: z.number(),
  staleAfterMs: z.number().int().positive().optional(),
});

export type MarkStaleMissionWorkersParams = z.infer<
  typeof MarkStaleMissionWorkersParamsSchema
>;

export const SubmitMissionWorkerReportParamsSchema = z.object({
  workerId: z.number(),
  report: MissionWorkerReportSchema,
  complete: z.boolean().optional().default(true),
});

export type SubmitMissionWorkerReportParams = z.infer<
  typeof SubmitMissionWorkerReportParamsSchema
>;

export const PrepareMissionWorkerWorkspaceParamsSchema = z.object({
  workerId: z.number(),
});

export type PrepareMissionWorkerWorkspaceParams = z.infer<
  typeof PrepareMissionWorkerWorkspaceParamsSchema
>;

export const SetMissionWorkerIntegrationStatusParamsSchema = z.object({
  workerId: z.number(),
  status: z.enum(["pending", "applied", "rejected"]),
  reason: z.string().trim().optional(),
});

export type SetMissionWorkerIntegrationStatusParams = z.infer<
  typeof SetMissionWorkerIntegrationStatusParamsSchema
>;

export const missionContracts = {
  createMission: defineContract({
    channel: "mission:create",
    input: CreateMissionParamsSchema,
    output: MissionSchema,
  }),

  getMission: defineContract({
    channel: "mission:get",
    input: z.object({ missionId: z.number() }),
    output: MissionSchema,
  }),

  listMissionsForApp: defineContract({
    channel: "mission:list-for-app",
    input: z.object({ appId: z.number() }),
    output: z.array(MissionSchema),
  }),

  updateMissionStatus: defineContract({
    channel: "mission:update-status",
    input: UpdateMissionStatusParamsSchema,
    output: MissionSchema,
  }),

  addMissionEvent: defineContract({
    channel: "mission:add-event",
    input: AddMissionEventParamsSchema,
    output: MissionEventSchema,
  }),

  listMissionEvents: defineContract({
    channel: "mission:list-events",
    input: z.object({ missionId: z.number() }),
    output: z.array(MissionEventSchema),
  }),

  listMissionTasks: defineContract({
    channel: "mission:list-tasks",
    input: z.object({ missionId: z.number() }),
    output: z.array(MissionTaskSchema),
  }),

  listMissionRuns: defineContract({
    channel: "mission:list-runs",
    input: z.object({ missionId: z.number() }),
    output: z.array(MissionRunSchema),
  }),

  createMissionWorker: defineContract({
    channel: "mission:create-worker",
    input: CreateMissionWorkerParamsSchema,
    output: MissionWorkerSchema,
  }),

  updateMissionWorkerStatus: defineContract({
    channel: "mission:update-worker-status",
    input: UpdateMissionWorkerStatusParamsSchema,
    output: MissionWorkerSchema,
  }),

  listMissionWorkers: defineContract({
    channel: "mission:list-workers",
    input: z.object({ missionId: z.number() }),
    output: z.array(MissionWorkerSchema),
  }),

  dispatchMissionWorkers: defineContract({
    channel: "mission:dispatch-workers",
    input: DispatchMissionWorkersParamsSchema,
    output: z.array(MissionWorkerSchema),
  }),

  retryMissionWorker: defineContract({
    channel: "mission:retry-worker",
    input: RetryMissionWorkerParamsSchema,
    output: MissionWorkerSchema,
  }),

  markStaleMissionWorkers: defineContract({
    channel: "mission:mark-stale-workers",
    input: MarkStaleMissionWorkersParamsSchema,
    output: z.array(MissionWorkerSchema),
  }),

  submitMissionWorkerReport: defineContract({
    channel: "mission:submit-worker-report",
    input: SubmitMissionWorkerReportParamsSchema,
    output: MissionWorkerSchema,
  }),

  prepareMissionWorkerWorkspace: defineContract({
    channel: "mission:prepare-worker-workspace",
    input: PrepareMissionWorkerWorkspaceParamsSchema,
    output: MissionWorkerSchema,
  }),

  setMissionWorkerIntegrationStatus: defineContract({
    channel: "mission:set-worker-integration-status",
    input: SetMissionWorkerIntegrationStatusParamsSchema,
    output: MissionWorkerSchema,
  }),

  listMissionCheckpoints: defineContract({
    channel: "mission:list-checkpoints",
    input: z.object({ missionId: z.number() }),
    output: z.array(MissionCheckpointSchema),
  }),

  listMissionArtifacts: defineContract({
    channel: "mission:list-artifacts",
    input: z.object({ missionId: z.number() }),
    output: z.array(MissionArtifactSchema),
  }),
} as const;

export const missionClient = createClient(missionContracts);
