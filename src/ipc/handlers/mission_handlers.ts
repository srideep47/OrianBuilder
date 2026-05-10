import crypto from "node:crypto";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import type { IpcMainInvokeEvent } from "electron";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import log from "electron-log";

import { db } from "@/db";
import {
  apps,
  messages,
  missionArtifacts,
  missionCheckpoints,
  missionEvents,
  missionInterrupts,
  missionMemories,
  missionPermissionRequests,
  missionRuns,
  missions,
  missionTasks,
  missionWorkers,
} from "@/db/schema";
import { getOrianBuilderAppPath } from "@/paths/paths";
import { readSettings } from "@/main/settings";
import { constructSystemPrompt, readAiRules } from "@/prompts/system_prompt";
import { handleLocalAgentStream } from "@/pro/main/ipc/handlers/local_agent/local_agent_handler";
import { createLoggedTypedHandler } from "./base";
import { missionContracts } from "../types/mission";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import {
  createMissionInterrupt,
  logMissionEvent,
} from "../utils/mission_utils";
import { getPostCreateGateStatus } from "../utils/mission_gates";
import {
  DEFAULT_WORKER_STALE_AFTER_MS,
  buildWorkerLifecycleMetadata,
  buildWorkerIntegrationMetadata,
  buildWorkerStaleMetadata,
  detectStaleRunningWorkers,
  getWorkerDependencyBlocks,
  getWorkerReport,
  mergeWorkerMetadata,
  normalizeMissionWorkerReport,
  selectDispatchableWorkers,
  workerHasStaleMetadata,
} from "../utils/mission_workers";
import { getMissionWorkspaceProvider } from "../utils/mission_workspace_provider";
import { execGit } from "../utils/git_utils";
import {
  assertRelativeWorkerOutputPath,
  detectWorkerApplyConflicts,
  parseWorkerNameStatusOutput,
  type WorkerBranchChange,
} from "../utils/mission_worker_output_apply";

const logger = log.scope("mission_handlers");
const handle = createLoggedTypedHandler(logger);

async function getMissionOrThrow(missionId: number) {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
  });

  if (!mission) {
    throw new OrianBuilderError(
      `Mission not found: ${missionId}`,
      OrianBuilderErrorKind.NotFound,
    );
  }

  return mission;
}

async function getMissionWorkerOrThrow(workerId: number) {
  const worker = await db.query.missionWorkers.findFirst({
    where: eq(missionWorkers.id, workerId),
  });

  if (!worker) {
    throw new OrianBuilderError(
      `Mission worker not found: ${workerId}`,
      OrianBuilderErrorKind.NotFound,
    );
  }

  return worker;
}

export function registerMissionHandlers() {
  handle(missionContracts.createMission, async (_event, params) => {
    const now = new Date();
    const [mission] = await db
      .insert(missions)
      .values({
        appId: params.appId,
        chatId: params.chatId ?? null,
        title: params.title,
        goal: params.goal,
        autonomyProfile: params.autonomyProfile ?? "supervised",
        status: "queued",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await logMissionEvent({
      missionId: mission.id,
      eventType: "mission_created",
      summary: `Mission created: ${mission.title}`,
      body: mission.goal,
      metadata: {
        appId: mission.appId,
        chatId: mission.chatId,
        autonomyProfile: mission.autonomyProfile,
      },
    });

    return mission;
  });

  handle(missionContracts.getMission, async (_event, { missionId }) => {
    return getMissionOrThrow(missionId);
  });

  handle(missionContracts.listMissionsForApp, async (_event, { appId }) => {
    return db.query.missions.findMany({
      where: eq(missions.appId, appId),
      orderBy: [desc(missions.updatedAt)],
    });
  });

  handle(
    missionContracts.updateMissionStatus,
    async (
      _event,
      { missionId, status, waiveIncompleteGates, waiverReason },
    ) => {
      await getMissionOrThrow(missionId);
      if (status === "completed") {
        const events = await db
          .select()
          .from(missionEvents)
          .where(eq(missionEvents.missionId, missionId));
        const gateStatus = getPostCreateGateStatus(events);
        if (gateStatus.isRequired && !gateStatus.isSatisfied) {
          if (!waiveIncompleteGates) {
            throw new OrianBuilderError(
              `Cannot complete mission until post-create verification passes. Missing: ${gateStatus.missingChecks.join(", ")}`,
              OrianBuilderErrorKind.Precondition,
            );
          }
          await logMissionEvent({
            missionId,
            eventType: "post_create_verification_waived",
            summary: `Post-create verification waived: ${gateStatus.missingChecks.join(", ")}`,
            metadata: {
              gate: "post_create_verification",
              status: "waived",
              requiredChecks: gateStatus.requiredChecks,
              completedChecks: gateStatus.completedChecks,
              missingChecks: gateStatus.missingChecks,
              failedChecks: gateStatus.failedChecks,
              reason: waiverReason ?? null,
            },
          });
        }
      }
      const now = new Date();
      const [mission] = await db
        .update(missions)
        .set({
          status,
          updatedAt: now,
          startedAt: status === "running" ? now : undefined,
          completedAt: ["completed", "failed", "cancelled"].includes(status)
            ? now
            : undefined,
        })
        .where(eq(missions.id, missionId))
        .returning();

      await logMissionEvent({
        missionId,
        eventType: "mission_status_changed",
        summary: `Mission marked ${status}`,
        metadata: {
          status,
          waiveIncompleteGates: waiveIncompleteGates ?? false,
          waiverReason: waiverReason ?? null,
        },
      });

      return mission;
    },
  );

  handle(missionContracts.addMissionEvent, async (_event, params) => {
    await getMissionOrThrow(params.missionId);
    const event = await logMissionEvent(params);
    if (!event) {
      throw new OrianBuilderError(
        "Mission event was not recorded.",
        OrianBuilderErrorKind.Internal,
      );
    }
    return event;
  });

  handle(missionContracts.listMissionEvents, async (_event, { missionId }) => {
    await getMissionOrThrow(missionId);
    return db
      .select()
      .from(missionEvents)
      .where(and(eq(missionEvents.missionId, missionId)))
      .orderBy(desc(missionEvents.createdAt));
  });

  handle(missionContracts.listMissionTasks, async (_event, { missionId }) => {
    await getMissionOrThrow(missionId);
    return db
      .select()
      .from(missionTasks)
      .where(eq(missionTasks.missionId, missionId))
      .orderBy(missionTasks.orderIndex);
  });

  handle(missionContracts.listMissionRuns, async (_event, { missionId }) => {
    await getMissionOrThrow(missionId);
    return db
      .select()
      .from(missionRuns)
      .where(eq(missionRuns.missionId, missionId))
      .orderBy(desc(missionRuns.startedAt));
  });

  handle(missionContracts.createMissionWorker, async (_event, params) => {
    await getMissionOrThrow(params.missionId);
    const now = new Date();
    const [worker] = await db
      .insert(missionWorkers)
      .values({
        missionId: params.missionId,
        workerKey: params.workerKey,
        role: params.role,
        title: params.title,
        goal: params.goal,
        workspaceProvider: params.workspaceProvider ?? "local",
        workspaceRef: params.workspaceRef ?? null,
        branchName: params.branchName ?? null,
        fileScopes: params.fileScopes ?? null,
        dependsOn: params.dependsOn ?? null,
        metadata: params.metadata ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await logMissionEvent({
      missionId: worker.missionId,
      eventType: "mission_worker_created",
      summary: `Worker created: ${worker.title}`,
      metadata: {
        workerId: worker.id,
        workerKey: worker.workerKey,
        role: worker.role,
        status: worker.status,
        workspaceProvider: worker.workspaceProvider,
        workspaceRef: worker.workspaceRef,
        branchName: worker.branchName,
        fileScopes: worker.fileScopes,
        dependsOn: worker.dependsOn,
      },
    });

    return worker;
  });

  handle(
    missionContracts.updateMissionWorkerStatus,
    async (_event, { workerId, status, metadata }) => {
      const existingWorker = await getMissionWorkerOrThrow(workerId);

      const now = new Date();
      const [worker] = await db
        .update(missionWorkers)
        .set({
          status,
          metadata:
            metadata ??
            buildWorkerLifecycleMetadata({
              existing: existingWorker.metadata,
              status,
              now,
            }),
          updatedAt: now,
          startedAt: status === "running" ? now : undefined,
          completedAt: ["completed", "failed", "cancelled"].includes(status)
            ? now
            : undefined,
        })
        .where(eq(missionWorkers.id, workerId))
        .returning();

      await logMissionEvent({
        missionId: worker.missionId,
        eventType: "mission_worker_status_changed",
        summary: `Worker ${worker.workerKey} marked ${status}`,
        metadata: {
          workerId: worker.id,
          workerKey: worker.workerKey,
          role: worker.role,
          status,
          ...metadata,
        },
      });

      return worker;
    },
  );

  handle(missionContracts.listMissionWorkers, async (_event, { missionId }) => {
    await getMissionOrThrow(missionId);
    return db
      .select()
      .from(missionWorkers)
      .where(eq(missionWorkers.missionId, missionId))
      .orderBy(missionWorkers.createdAt);
  });

  handle(
    missionContracts.dispatchMissionWorkers,
    async (_event, { missionId, status }) => {
      await getMissionOrThrow(missionId);
      const allWorkers = await db
        .select()
        .from(missionWorkers)
        .where(eq(missionWorkers.missionId, missionId))
        .orderBy(missionWorkers.createdAt);
      const dependencyBlocks = getWorkerDependencyBlocks(allWorkers);
      const workersToDispatch = selectDispatchableWorkers(allWorkers).filter(
        (worker) => worker.status !== status,
      );

      if (workersToDispatch.length === 0) {
        await logMissionEvent({
          missionId,
          eventType: "mission_workers_dispatch_skipped",
          summary: "No workers are ready to dispatch",
          metadata: {
            requestedStatus: status,
            dependencyBlocks,
          },
        });
        return [];
      }

      const now = new Date();
      const updatedWorkers = [];
      for (const existingWorker of workersToDispatch) {
        const [worker] = await db
          .update(missionWorkers)
          .set({
            status,
            metadata: buildWorkerLifecycleMetadata({
              existing: existingWorker.metadata,
              status,
              reason: "dependencies_satisfied",
              now,
            }),
            updatedAt: now,
            startedAt: status === "running" ? now : undefined,
            completedAt: null,
          })
          .where(eq(missionWorkers.id, existingWorker.id))
          .returning();

        updatedWorkers.push(worker);
        await logMissionEvent({
          missionId,
          eventType: "mission_worker_dispatched",
          summary: `Worker ${worker.workerKey} marked ${status}`,
          metadata: {
            workerId: worker.id,
            workerKey: worker.workerKey,
            role: worker.role,
            status,
            dependsOn: worker.dependsOn,
          },
        });
      }

      return updatedWorkers;
    },
  );

  handle(
    missionContracts.retryMissionWorker,
    async (_event, { workerId, reason }) => {
      const existingWorker = await getMissionWorkerOrThrow(workerId);
      if (
        !["blocked", "failed", "cancelled", "running"].includes(
          existingWorker.status,
        ) ||
        (existingWorker.status === "running" &&
          !workerHasStaleMetadata(existingWorker))
      ) {
        throw new OrianBuilderError(
          `Only blocked, failed, cancelled, or stale running workers can be retried. Current status: ${existingWorker.status}`,
          OrianBuilderErrorKind.Precondition,
        );
      }

      const now = new Date();
      const [worker] = await db
        .update(missionWorkers)
        .set({
          status: "queued",
          metadata: buildWorkerLifecycleMetadata({
            existing: mergeWorkerMetadata(existingWorker.metadata, {
              retryReason: reason ?? null,
              retryPreviousStatus: existingWorker.status,
            }),
            status: "queued",
            reason: reason ?? "retry_requested",
            now,
          }),
          updatedAt: now,
          startedAt: null,
          completedAt: null,
        })
        .where(eq(missionWorkers.id, workerId))
        .returning();

      await logMissionEvent({
        missionId: worker.missionId,
        eventType: "mission_worker_retry_requested",
        summary: `Worker ${worker.workerKey} queued for retry`,
        metadata: {
          workerId: worker.id,
          workerKey: worker.workerKey,
          role: worker.role,
          previousStatus: existingWorker.status,
          reason: reason ?? null,
        },
      });

      return worker;
    },
  );

  handle(
    missionContracts.markStaleMissionWorkers,
    async (_event, { missionId, staleAfterMs }) => {
      await getMissionOrThrow(missionId);
      const allWorkers = await db
        .select()
        .from(missionWorkers)
        .where(eq(missionWorkers.missionId, missionId))
        .orderBy(missionWorkers.createdAt);
      const now = new Date();
      const staleWorkers = detectStaleRunningWorkers(
        allWorkers,
        now,
        staleAfterMs ?? DEFAULT_WORKER_STALE_AFTER_MS,
      );
      if (staleWorkers.length === 0) {
        await logMissionEvent({
          missionId,
          eventType: "mission_workers_stale_check",
          summary: "No stale workers detected",
          metadata: {
            staleAfterMs: staleAfterMs ?? DEFAULT_WORKER_STALE_AFTER_MS,
          },
        });
        return [];
      }

      const staleByKey = new Map(
        staleWorkers.map((worker) => [worker.workerKey, worker]),
      );
      const updatedWorkers = [];
      for (const existingWorker of allWorkers) {
        const stale = staleByKey.get(existingWorker.workerKey);
        if (!stale) continue;

        const [worker] = await db
          .update(missionWorkers)
          .set({
            metadata: buildWorkerStaleMetadata({
              existing: existingWorker.metadata,
              staleForMs: stale.staleForMs,
              now,
            }),
            updatedAt: now,
          })
          .where(eq(missionWorkers.id, existingWorker.id))
          .returning();
        updatedWorkers.push(worker);

        await logMissionEvent({
          missionId,
          eventType: "mission_worker_stale",
          summary: `Worker ${worker.workerKey} appears stale`,
          metadata: {
            workerId: worker.id,
            workerKey: worker.workerKey,
            role: worker.role,
            status: worker.status,
            staleForMs: stale.staleForMs,
          },
        });
        await createMissionInterrupt({
          missionId,
          source: "worker",
          title: `Worker stale: ${worker.workerKey}`,
          body: `Worker ${worker.workerKey} appears stale after ${stale.staleForMs}ms and may need retry or reassignment.`,
          metadata: {
            producer: "mission_worker_stale",
            workerId: worker.id,
            workerKey: worker.workerKey,
            role: worker.role,
            staleForMs: stale.staleForMs,
          },
        });
      }

      return updatedWorkers;
    },
  );

  handle(
    missionContracts.submitMissionWorkerReport,
    async (_event, { workerId, report, complete }) => {
      const existingWorker = await getMissionWorkerOrThrow(workerId);
      const normalizedReport = normalizeMissionWorkerReport(report);
      const now = new Date();
      const nextStatus = complete ? "completed" : existingWorker.status;
      const [worker] = await db
        .update(missionWorkers)
        .set({
          status: nextStatus,
          metadata: buildWorkerLifecycleMetadata({
            existing: mergeWorkerMetadata(existingWorker.metadata, {
              report: normalizedReport,
              reportSubmittedAt: now.toISOString(),
            }),
            status: nextStatus,
            reason: "completion_report_submitted",
            now,
          }),
          updatedAt: now,
          completedAt: complete ? now : undefined,
        })
        .where(eq(missionWorkers.id, workerId))
        .returning();

      await logMissionEvent({
        missionId: worker.missionId,
        eventType: "mission_worker_report_submitted",
        summary: `Worker ${worker.workerKey} submitted a report`,
        body: normalizedReport.summary,
        metadata: {
          workerId: worker.id,
          workerKey: worker.workerKey,
          role: worker.role,
          status: worker.status,
          report: normalizedReport,
        },
      });
      await createMissionInterrupt({
        missionId: worker.missionId,
        source: "worker",
        title: `Worker report: ${worker.workerKey}`,
        body: normalizedReport.blockers
          ? `${normalizedReport.summary} Blockers: ${normalizedReport.blockers}`
          : normalizedReport.summary,
        metadata: {
          producer: "mission_worker_report_submitted",
          workerId: worker.id,
          workerKey: worker.workerKey,
          role: worker.role,
          status: worker.status,
          report: normalizedReport,
        },
      });

      return worker;
    },
  );

  handle(
    missionContracts.prepareMissionWorkerWorkspace,
    async (_event, { workerId }) => {
      const existingWorker = await getMissionWorkerOrThrow(workerId);
      const mission = await getMissionOrThrow(existingWorker.missionId);
      const appRecord = await db.query.apps.findFirst({
        where: eq(apps.id, mission.appId),
      });
      if (!appRecord) {
        throw new OrianBuilderError(
          `App not found for mission worker: ${mission.appId}`,
          OrianBuilderErrorKind.NotFound,
        );
      }

      const provider = getMissionWorkspaceProvider(
        existingWorker.workspaceProvider,
      );
      const prepared = await provider.prepare({
        appPath: getOrianBuilderAppPath(appRecord.path),
        missionId: mission.id,
        worker: existingWorker,
      });
      const now = new Date();
      const [worker] = await db
        .update(missionWorkers)
        .set({
          workspaceRef: prepared.workspaceRef,
          branchName: prepared.branchName,
          metadata: mergeWorkerMetadata(existingWorker.metadata, {
            workspacePreparedAt: now.toISOString(),
            workspaceProvider: prepared.provider,
            promptPackage: prepared.promptPackage,
          }),
          updatedAt: now,
        })
        .where(eq(missionWorkers.id, workerId))
        .returning();

      await logMissionEvent({
        missionId: worker.missionId,
        eventType: "mission_worker_workspace_prepared",
        summary: `Worker ${worker.workerKey} workspace prepared`,
        body: prepared.promptPackage,
        metadata: {
          workerId: worker.id,
          workerKey: worker.workerKey,
          role: worker.role,
          workspaceProvider: worker.workspaceProvider,
          workspaceRef: worker.workspaceRef,
          branchName: worker.branchName,
        },
      });

      return worker;
    },
  );

  handle(
    missionContracts.setMissionWorkerIntegrationStatus,
    async (_event, { workerId, status, reason }) => {
      const existingWorker = await getMissionWorkerOrThrow(workerId);
      const report = getWorkerReport(existingWorker.metadata);
      if (!report) {
        throw new OrianBuilderError(
          `Worker ${existingWorker.workerKey} has no completion report to integrate.`,
          OrianBuilderErrorKind.Precondition,
        );
      }

      const now = new Date();
      const [worker] = await db
        .update(missionWorkers)
        .set({
          metadata: buildWorkerIntegrationMetadata({
            existing: existingWorker.metadata,
            status,
            reason,
            now,
          }),
          updatedAt: now,
        })
        .where(eq(missionWorkers.id, workerId))
        .returning();

      await logMissionEvent({
        missionId: worker.missionId,
        eventType: "mission_worker_integration_status_changed",
        summary: `Worker ${worker.workerKey} integration marked ${status}`,
        body: report.summary,
        metadata: {
          workerId: worker.id,
          workerKey: worker.workerKey,
          role: worker.role,
          status,
          reason: reason ?? null,
          changedFiles: report.changedFiles,
          validation: report.validation,
          blockers: report.blockers,
          artifacts: report.artifacts,
        },
      });

      return worker;
    },
  );

  handle(
    missionContracts.runReadyMissionWorkers,
    async (event, { missionId, limit }) => {
      const mission = await getMissionOrThrow(missionId);
      if (!mission.chatId) {
        throw new OrianBuilderError(
          "Mission workers can only run for missions attached to a chat.",
          OrianBuilderErrorKind.Precondition,
        );
      }

      const appRecord = await db.query.apps.findFirst({
        where: eq(apps.id, mission.appId),
      });
      if (!appRecord) {
        throw new OrianBuilderError(
          `App not found for mission: ${mission.appId}`,
          OrianBuilderErrorKind.NotFound,
        );
      }

      const allWorkers = await db
        .select()
        .from(missionWorkers)
        .where(eq(missionWorkers.missionId, missionId))
        .orderBy(missionWorkers.createdAt);
      const readyWorkers = selectDispatchableWorkers(allWorkers)
        .filter((worker) => worker.status === "ready")
        .slice(0, limit);

      if (readyWorkers.length === 0) {
        await logMissionEvent({
          missionId,
          eventType: "mission_worker_run_skipped",
          summary: "No ready workers are available to run",
        });
        return [];
      }

      const completedWorkers = [];
      for (const readyWorker of readyWorkers) {
        const worker = await runMissionWorker({
          event,
          mission,
          appPath: getOrianBuilderAppPath(appRecord.path),
          worker: readyWorker,
        });
        completedWorkers.push(worker);
      }

      return completedWorkers;
    },
  );

  handle(
    missionContracts.applyAcceptedMissionWorkerOutputs,
    async (_event, { missionId }) => {
      const mission = await getMissionOrThrow(missionId);
      const appRecord = await db.query.apps.findFirst({
        where: eq(apps.id, mission.appId),
      });
      if (!appRecord) {
        throw new OrianBuilderError(
          `App not found for mission: ${mission.appId}`,
          OrianBuilderErrorKind.NotFound,
        );
      }

      const allWorkers = await db
        .select()
        .from(missionWorkers)
        .where(eq(missionWorkers.missionId, missionId))
        .orderBy(missionWorkers.createdAt);
      const acceptedWorkers = allWorkers.filter(
        (worker) =>
          worker.status === "completed" &&
          getWorkerReport(worker.metadata) &&
          getMetadataString(worker.metadata, "integrationStatus") ===
            "applied" &&
          !getMetadataString(worker.metadata, "outputAppliedAt"),
      );

      if (acceptedWorkers.length === 0) {
        await logMissionEvent({
          missionId,
          eventType: "mission_worker_output_apply_skipped",
          summary: "No accepted worker outputs are ready to apply",
        });
        return [];
      }

      const appPath = getOrianBuilderAppPath(appRecord.path);
      const plannedChanges = [];
      for (const worker of acceptedWorkers) {
        plannedChanges.push({
          worker,
          changes: await getWorkerBranchChanges({
            appPath,
            worker,
          }),
        });
      }
      const conflicts = detectWorkerApplyConflicts(
        plannedChanges.map((entry) => ({
          workerKey: entry.worker.workerKey,
          changes: entry.changes,
        })),
      );
      if (conflicts.length > 0) {
        await logMissionEvent({
          missionId,
          eventType: "mission_worker_output_apply_conflict",
          summary: `Worker output apply blocked by ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`,
          metadata: {
            conflicts,
          },
        });
        await createMissionInterrupt({
          missionId,
          source: "worker",
          title: "Worker output conflict",
          body: `Worker output apply is blocked by ${conflicts.length} changed-file conflict${conflicts.length === 1 ? "" : "s"}. Review integration before continuing.`,
          metadata: {
            producer: "mission_worker_output_apply_conflict",
            conflicts,
          },
        });
        throw new OrianBuilderError(
          `Cannot apply accepted worker outputs until conflicts are resolved: ${conflicts
            .map(
              (conflict) =>
                `${conflict.firstWorkerKey}/${conflict.secondWorkerKey} (${conflict.overlappingFiles.join(", ")})`,
            )
            .join("; ")}`,
          OrianBuilderErrorKind.Precondition,
        );
      }

      const appliedWorkers = [];
      for (const { worker, changes } of plannedChanges) {
        const appliedWorker = await applyWorkerOutput({
          mission,
          appPath,
          worker,
          changes,
        });
        appliedWorkers.push(appliedWorker);
      }

      return appliedWorkers;
    },
  );

  handle(
    missionContracts.cleanupAppliedMissionWorkerWorkspaces,
    async (_event, { missionId }) => {
      await getMissionOrThrow(missionId);
      const allWorkers = await db
        .select()
        .from(missionWorkers)
        .where(eq(missionWorkers.missionId, missionId))
        .orderBy(missionWorkers.createdAt);
      const cleanupTargets = allWorkers.filter(
        (worker) =>
          worker.workspaceProvider === "worktree" &&
          worker.workspaceRef &&
          getMetadataString(worker.metadata, "outputAppliedAt") &&
          !getMetadataString(worker.metadata, "workspaceCleanedAt"),
      );

      if (cleanupTargets.length === 0) {
        await logMissionEvent({
          missionId,
          eventType: "mission_worker_workspace_cleanup_skipped",
          summary: "No applied worker workspaces are ready for cleanup",
        });
        return [];
      }

      const cleanedWorkers = [];
      for (const worker of cleanupTargets) {
        cleanedWorkers.push(await cleanupWorkerWorkspace(worker));
      }
      return cleanedWorkers;
    },
  );

  handle(
    missionContracts.listMissionCheckpoints,
    async (_event, { missionId }) => {
      await getMissionOrThrow(missionId);
      return db
        .select()
        .from(missionCheckpoints)
        .where(eq(missionCheckpoints.missionId, missionId))
        .orderBy(desc(missionCheckpoints.createdAt));
    },
  );

  handle(
    missionContracts.listMissionArtifacts,
    async (_event, { missionId }) => {
      await getMissionOrThrow(missionId);
      return db
        .select()
        .from(missionArtifacts)
        .where(eq(missionArtifacts.missionId, missionId))
        .orderBy(desc(missionArtifacts.createdAt));
    },
  );

  handle(missionContracts.createMissionInterrupt, async (_event, params) => {
    await getMissionOrThrow(params.missionId);
    const interrupt = await createMissionInterrupt({
      missionId: params.missionId,
      source: params.source,
      title: params.title,
      body: params.body,
      metadata: params.metadata ?? null,
    });
    if (!interrupt) {
      throw new OrianBuilderError(
        "Mission interrupt was not recorded.",
        OrianBuilderErrorKind.Internal,
      );
    }

    await logMissionEvent({
      missionId: interrupt.missionId,
      eventType: "mission_interrupt_created",
      summary: `Interrupt queued: ${interrupt.title}`,
      body: interrupt.body,
      metadata: {
        interruptId: interrupt.id,
        source: interrupt.source,
        status: interrupt.status,
        ...interrupt.metadata,
      },
    });

    return interrupt;
  });

  handle(
    missionContracts.listMissionInterrupts,
    async (_event, { missionId }) => {
      await getMissionOrThrow(missionId);
      return db
        .select()
        .from(missionInterrupts)
        .where(eq(missionInterrupts.missionId, missionId))
        .orderBy(desc(missionInterrupts.createdAt));
    },
  );

  handle(
    missionContracts.markMissionInterruptsInjected,
    async (_event, { missionId, interruptIds }) => {
      await getMissionOrThrow(missionId);
      const now = new Date();
      const updated = await db
        .update(missionInterrupts)
        .set({
          status: "injected",
          injectedAt: now,
        })
        .where(
          and(
            eq(missionInterrupts.missionId, missionId),
            inArray(missionInterrupts.id, interruptIds),
          ),
        )
        .returning();

      await logMissionEvent({
        missionId,
        eventType: "mission_interrupts_injected",
        summary: `${updated.length} interrupt${updated.length === 1 ? "" : "s"} injected`,
        metadata: {
          interruptIds: updated.map((interrupt) => interrupt.id),
        },
      });

      return updated;
    },
  );

  handle(missionContracts.createMissionMemory, async (_event, params) => {
    const appRecord = await db.query.apps.findFirst({
      where: eq(apps.id, params.appId),
    });
    if (!appRecord) {
      throw new OrianBuilderError(
        `App not found: ${params.appId}`,
        OrianBuilderErrorKind.NotFound,
      );
    }
    if (params.missionId) {
      const mission = await getMissionOrThrow(params.missionId);
      if (mission.appId !== params.appId) {
        throw new OrianBuilderError(
          "Mission memory appId must match the mission app.",
          OrianBuilderErrorKind.Validation,
        );
      }
    }

    const now = new Date();
    const [memory] = await db
      .insert(missionMemories)
      .values({
        appId: params.appId,
        missionId: params.missionId ?? null,
        category: params.category,
        title: params.title,
        body: params.body,
        metadata: params.metadata ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (memory.missionId) {
      await logMissionEvent({
        missionId: memory.missionId,
        eventType: "mission_memory_recorded",
        summary: `Memory recorded: ${memory.title}`,
        body: memory.body,
        metadata: {
          memoryId: memory.id,
          category: memory.category,
        },
      });
    }

    return memory;
  });

  handle(
    missionContracts.listMissionMemories,
    async (_event, { appId, missionId, query }) => {
      const records = await db
        .select()
        .from(missionMemories)
        .where(
          and(
            eq(missionMemories.appId, appId),
            missionId
              ? or(
                  eq(missionMemories.missionId, missionId),
                  isNull(missionMemories.missionId),
                )
              : isNull(missionMemories.missionId),
          ),
        )
        .orderBy(desc(missionMemories.updatedAt));

      const normalizedQuery = query?.toLowerCase();
      if (!normalizedQuery) {
        return records;
      }

      return records.filter((memory) =>
        [memory.title, memory.body, memory.category].some((value) =>
          value.toLowerCase().includes(normalizedQuery),
        ),
      );
    },
  );

  handle(
    missionContracts.createMissionPermissionRequest,
    async (_event, params) => {
      await getMissionOrThrow(params.missionId);
      const now = new Date();
      const [request] = await db
        .insert(missionPermissionRequests)
        .values({
          missionId: params.missionId,
          runId: params.runId ?? null,
          action: params.action,
          risk: params.risk,
          reason: params.reason,
          metadata: params.metadata ?? null,
          createdAt: now,
        })
        .returning();

      await logMissionEvent({
        missionId: request.missionId,
        eventType: "mission_permission_requested",
        summary: `Permission requested: ${request.action}`,
        body: request.reason,
        metadata: {
          requestId: request.id,
          runId: request.runId,
          risk: request.risk,
          status: request.status,
        },
      });

      return request;
    },
  );

  handle(
    missionContracts.listMissionPermissionRequests,
    async (_event, { missionId }) => {
      await getMissionOrThrow(missionId);
      return db
        .select()
        .from(missionPermissionRequests)
        .where(eq(missionPermissionRequests.missionId, missionId))
        .orderBy(desc(missionPermissionRequests.createdAt));
    },
  );

  handle(
    missionContracts.resolveMissionPermissionRequest,
    async (_event, { requestId, status }) => {
      const existingRequest =
        await db.query.missionPermissionRequests.findFirst({
          where: eq(missionPermissionRequests.id, requestId),
        });
      if (!existingRequest) {
        throw new OrianBuilderError(
          `Mission permission request not found: ${requestId}`,
          OrianBuilderErrorKind.NotFound,
        );
      }
      if (existingRequest.status !== "pending") {
        throw new OrianBuilderError(
          `Only pending permission requests can be resolved. Current status: ${existingRequest.status}`,
          OrianBuilderErrorKind.Precondition,
        );
      }

      const now = new Date();
      const [request] = await db
        .update(missionPermissionRequests)
        .set({
          status,
          resolvedAt: now,
        })
        .where(eq(missionPermissionRequests.id, requestId))
        .returning();

      await logMissionEvent({
        missionId: request.missionId,
        eventType: "mission_permission_resolved",
        summary: `Permission ${status}: ${request.action}`,
        body: request.reason,
        metadata: {
          requestId: request.id,
          runId: request.runId,
          risk: request.risk,
          status: request.status,
        },
      });

      return request;
    },
  );

  handle(
    missionContracts.expireMissionPermissionRequests,
    async (_event, { missionId, olderThanMs }) => {
      await getMissionOrThrow(missionId);
      const now = new Date();
      const cutoff = new Date(now.getTime() - olderThanMs);
      const expired = await db
        .update(missionPermissionRequests)
        .set({
          status: "expired",
          resolvedAt: now,
        })
        .where(
          and(
            eq(missionPermissionRequests.missionId, missionId),
            eq(missionPermissionRequests.status, "pending"),
            lt(missionPermissionRequests.createdAt, cutoff),
          ),
        )
        .returning();

      if (expired.length > 0) {
        await logMissionEvent({
          missionId,
          eventType: "mission_permission_requests_expired",
          summary: `${expired.length} permission request${expired.length === 1 ? "" : "s"} expired`,
          metadata: {
            requestIds: expired.map((request) => request.id),
            olderThanMs,
          },
        });
      }

      return expired;
    },
  );
}

async function runMissionWorker(input: {
  event: IpcMainInvokeEvent;
  mission: typeof missions.$inferSelect;
  appPath: string;
  worker: typeof missionWorkers.$inferSelect;
}) {
  const preparedWorker = await ensureWorkerWorkspacePrepared(input);
  const workspacePath = preparedWorker.workspaceRef ?? input.appPath;
  const now = new Date();
  const [runningWorker] = await db
    .update(missionWorkers)
    .set({
      status: "running",
      metadata: buildWorkerLifecycleMetadata({
        existing: preparedWorker.metadata,
        status: "running",
        reason: "worker_runtime_started",
        now,
      }),
      updatedAt: now,
      startedAt: now,
      completedAt: null,
    })
    .where(eq(missionWorkers.id, preparedWorker.id))
    .returning();

  await logMissionEvent({
    missionId: input.mission.id,
    eventType: "mission_worker_run_started",
    summary: `Worker ${runningWorker.workerKey} run started`,
    body: getWorkerPromptPackage(runningWorker),
    metadata: {
      workerId: runningWorker.id,
      workerKey: runningWorker.workerKey,
      role: runningWorker.role,
      workspaceProvider: runningWorker.workspaceProvider,
      workspaceRef: workspacePath,
      branchName: runningWorker.branchName,
    },
  });

  const prompt = buildWorkerRuntimePrompt({
    mission: input.mission,
    worker: runningWorker,
  });
  const settings = readSettings();
  const aiRules = await readAiRules(workspacePath);
  const systemPrompt = constructSystemPrompt({
    aiRules,
    chatMode: "local-agent",
    enableTurboEditsV2: false,
    basicAgentMode: false,
  });
  const orianbuilderRequestId = `worker:${runningWorker.id}:${crypto.randomUUID()}`;

  const [userMessage] = await db
    .insert(messages)
    .values({
      chatId: input.mission.chatId!,
      role: "user",
      content: prompt,
    })
    .returning({ id: messages.id });
  const [assistantMessage] = await db
    .insert(messages)
    .values({
      chatId: input.mission.chatId!,
      role: "assistant",
      content: "",
      requestId: orianbuilderRequestId,
      model: settings.selectedModel.name,
    })
    .returning({ id: messages.id });

  const baseRef = await captureGitHead(workspacePath);
  const success = await handleLocalAgentStream(
    input.event,
    {
      chatId: input.mission.chatId!,
      prompt,
      missionId: input.mission.id,
    },
    new AbortController(),
    {
      placeholderMessageId: assistantMessage.id,
      systemPrompt,
      orianbuilderRequestId,
      settingsOverride: settings,
      workspacePathOverride: workspacePath,
      workerId: runningWorker.id,
    },
  );

  const diff = await captureWorkerGitDiff(workspacePath, baseRef);
  const completedAt = new Date();
  const report = normalizeMissionWorkerReport({
    summary: success
      ? `Worker ${runningWorker.workerKey} completed its isolated run.`
      : `Worker ${runningWorker.workerKey} failed during its isolated run.`,
    changedFiles: diff.changedFiles,
    validation: diff.stat || null,
    blockers: success ? null : "Local-agent worker stream failed.",
    artifacts: diff.patch
      ? ["mission_worker_diff_captured event body"]
      : ["worker run chat messages"],
  });
  const nextStatus = success ? "completed" : "failed";
  const [finishedWorker] = await db
    .update(missionWorkers)
    .set({
      status: nextStatus,
      metadata: buildWorkerLifecycleMetadata({
        existing: mergeWorkerMetadata(runningWorker.metadata, {
          report,
          reportSubmittedAt: completedAt.toISOString(),
          workerRunUserMessageId: userMessage.id,
          workerRunAssistantMessageId: assistantMessage.id,
          diffStat: diff.stat,
          diffCaptureError: diff.error,
        }),
        status: nextStatus,
        reason: success ? "worker_runtime_completed" : "worker_runtime_failed",
        now: completedAt,
      }),
      updatedAt: completedAt,
      completedAt,
    })
    .where(eq(missionWorkers.id, runningWorker.id))
    .returning();

  await logMissionEvent({
    missionId: input.mission.id,
    eventType: "mission_worker_report_submitted",
    summary: `Worker ${finishedWorker.workerKey} submitted an automatic runtime report`,
    body: report.summary,
    metadata: {
      workerId: finishedWorker.id,
      workerKey: finishedWorker.workerKey,
      role: finishedWorker.role,
      status: finishedWorker.status,
      report,
    },
  });
  await createMissionInterrupt({
    missionId: input.mission.id,
    source: "worker",
    title: `Worker ${finishedWorker.status}: ${finishedWorker.workerKey}`,
    body: report.blockers
      ? `${report.summary} Blockers: ${report.blockers}`
      : report.summary,
    metadata: {
      producer: "mission_worker_runtime_report",
      workerId: finishedWorker.id,
      workerKey: finishedWorker.workerKey,
      role: finishedWorker.role,
      status: finishedWorker.status,
      report,
    },
  });
  if (diff.patch || diff.error) {
    await logMissionEvent({
      missionId: input.mission.id,
      eventType: "mission_worker_diff_captured",
      summary: diff.error
        ? `Worker ${finishedWorker.workerKey} diff capture failed`
        : `Worker ${finishedWorker.workerKey} diff captured`,
      body: diff.error ?? diff.patch,
      metadata: {
        workerId: finishedWorker.id,
        workerKey: finishedWorker.workerKey,
        changedFiles: diff.changedFiles,
        stat: diff.stat,
        error: diff.error,
      },
    });
  }

  return finishedWorker;
}

async function applyWorkerOutput(input: {
  mission: typeof missions.$inferSelect;
  appPath: string;
  worker: typeof missionWorkers.$inferSelect;
  changes?: WorkerBranchChange[];
}) {
  if (!input.worker.workspaceRef) {
    throw new OrianBuilderError(
      `Worker ${input.worker.workerKey} has no prepared workspace to apply.`,
      OrianBuilderErrorKind.Precondition,
    );
  }

  const changes =
    input.changes ??
    (await getWorkerBranchChanges({
      appPath: input.appPath,
      worker: input.worker,
    }));
  if (changes.length === 0) {
    const now = new Date();
    const [worker] = await db
      .update(missionWorkers)
      .set({
        metadata: mergeWorkerMetadata(input.worker.metadata, {
          outputAppliedAt: now.toISOString(),
          outputApplyChangedFiles: [],
          outputApplyNote: "No branch diff to apply.",
        }),
        updatedAt: now,
      })
      .where(eq(missionWorkers.id, input.worker.id))
      .returning();
    await logMissionEvent({
      missionId: input.mission.id,
      eventType: "mission_worker_output_applied",
      summary: `Worker ${worker.workerKey} had no file output to apply`,
      metadata: {
        workerId: worker.id,
        workerKey: worker.workerKey,
        changedFiles: [],
      },
    });
    return worker;
  }

  const appliedFiles: string[] = [];
  for (const change of changes) {
    await applySingleWorkerFileChange({
      sourceRoot: input.worker.workspaceRef,
      targetRoot: input.appPath,
      change,
    });
    appliedFiles.push(change.path);
  }

  const now = new Date();
  const [worker] = await db
    .update(missionWorkers)
    .set({
      metadata: mergeWorkerMetadata(input.worker.metadata, {
        outputAppliedAt: now.toISOString(),
        outputApplyChangedFiles: appliedFiles,
      }),
      updatedAt: now,
    })
    .where(eq(missionWorkers.id, input.worker.id))
    .returning();

  await logMissionEvent({
    missionId: input.mission.id,
    eventType: "mission_worker_output_applied",
    summary: `Worker ${worker.workerKey} output applied`,
    metadata: {
      workerId: worker.id,
      workerKey: worker.workerKey,
      branchName: worker.branchName,
      workspaceRef: worker.workspaceRef,
      changedFiles: appliedFiles,
    },
  });

  return worker;
}

async function cleanupWorkerWorkspace(
  worker: typeof missionWorkers.$inferSelect,
) {
  const workspaceRef = worker.workspaceRef;
  if (!workspaceRef) {
    throw new OrianBuilderError(
      `Worker ${worker.workerKey} has no workspace to clean up.`,
      OrianBuilderErrorKind.Precondition,
    );
  }

  const result = await execGit(
    ["-C", workspaceRef, "worktree", "remove", workspaceRef],
    path.dirname(workspaceRef),
  );
  if (result.exitCode !== 0) {
    throw new OrianBuilderError(
      `Failed to remove worker workspace ${workspaceRef}: ${
        result.stderr.trim() || result.stdout.trim()
      }`,
      OrianBuilderErrorKind.External,
    );
  }

  const now = new Date();
  const [updatedWorker] = await db
    .update(missionWorkers)
    .set({
      metadata: mergeWorkerMetadata(worker.metadata, {
        workspaceCleanedAt: now.toISOString(),
        workspaceCleanedRef: workspaceRef,
      }),
      workspaceRef: null,
      updatedAt: now,
    })
    .where(eq(missionWorkers.id, worker.id))
    .returning();

  await logMissionEvent({
    missionId: worker.missionId,
    eventType: "mission_worker_workspace_cleaned",
    summary: `Worker ${worker.workerKey} workspace cleaned`,
    metadata: {
      workerId: worker.id,
      workerKey: worker.workerKey,
      workspaceRef,
      branchName: worker.branchName,
    },
  });

  return updatedWorker;
}

async function getWorkerBranchChanges(input: {
  appPath: string;
  worker: typeof missionWorkers.$inferSelect;
}): Promise<WorkerBranchChange[]> {
  if (!input.worker.branchName) {
    const report = getWorkerReport(input.worker.metadata);
    return (report?.changedFiles ?? []).map((filePath) => ({
      status: "M",
      path: filePath,
    }));
  }

  const result = await execGit(
    ["diff", "--name-status", "HEAD", input.worker.branchName],
    input.appPath,
  );
  if (result.exitCode !== 0) {
    throw new OrianBuilderError(
      `Failed to inspect worker branch ${input.worker.branchName}: ${
        result.stderr.trim() || result.stdout.trim()
      }`,
      OrianBuilderErrorKind.External,
    );
  }

  return parseWorkerNameStatusOutput(result.stdout);
}

async function applySingleWorkerFileChange(input: {
  sourceRoot: string;
  targetRoot: string;
  change: WorkerBranchChange;
}) {
  assertRelativeWorkerOutputPath(input.change.path);
  const targetPath = path.join(input.targetRoot, input.change.path);

  if (
    input.change.previousPath &&
    input.change.previousPath !== input.change.path
  ) {
    assertRelativeWorkerOutputPath(input.change.previousPath);
    await fsPromises
      .unlink(path.join(input.targetRoot, input.change.previousPath))
      .catch((err: unknown) => {
        if (!isNodeErrorCode(err, "ENOENT")) throw err;
      });
  }

  if (input.change.status.startsWith("D")) {
    await fsPromises.unlink(targetPath).catch((err: unknown) => {
      if (!isNodeErrorCode(err, "ENOENT")) throw err;
    });
    return;
  }

  const sourcePath = path.join(input.sourceRoot, input.change.path);
  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
  await fsPromises.copyFile(sourcePath, targetPath);
}

async function ensureWorkerWorkspacePrepared(input: {
  mission: typeof missions.$inferSelect;
  appPath: string;
  worker: typeof missionWorkers.$inferSelect;
}) {
  if (input.worker.workspaceRef) {
    return input.worker;
  }

  const provider = getMissionWorkspaceProvider(input.worker.workspaceProvider);
  const prepared = await provider.prepare({
    appPath: input.appPath,
    missionId: input.mission.id,
    worker: input.worker,
  });
  const now = new Date();
  const [worker] = await db
    .update(missionWorkers)
    .set({
      workspaceRef: prepared.workspaceRef,
      branchName: prepared.branchName,
      metadata: mergeWorkerMetadata(input.worker.metadata, {
        workspacePreparedAt: now.toISOString(),
        workspaceProvider: prepared.provider,
        promptPackage: prepared.promptPackage,
      }),
      updatedAt: now,
    })
    .where(eq(missionWorkers.id, input.worker.id))
    .returning();
  return worker;
}

function buildWorkerRuntimePrompt(input: {
  mission: typeof missions.$inferSelect;
  worker: typeof missionWorkers.$inferSelect;
}) {
  return [
    "Run this mission worker package now.",
    "",
    `Mission: ${input.mission.title}`,
    `Mission goal: ${input.mission.goal}`,
    "",
    getWorkerPromptPackage(input.worker),
    "",
    "Rules:",
    "- Work only inside this worker workspace.",
    "- Stay within the file scopes unless a dependency is absolutely required.",
    "- Run focused validation when practical.",
    "- End with a concise summary of changed files, validation, and blockers.",
  ].join("\n");
}

function getWorkerPromptPackage(worker: typeof missionWorkers.$inferSelect) {
  const metadata = worker.metadata;
  const promptPackage =
    metadata && typeof metadata === "object" && "promptPackage" in metadata
      ? metadata.promptPackage
      : null;
  if (typeof promptPackage === "string" && promptPackage.trim()) {
    return promptPackage;
  }
  return [
    `Mission worker: ${worker.workerKey}`,
    `Role: ${worker.role}`,
    `Title: ${worker.title}`,
    `Goal: ${worker.goal}`,
    `Workspace provider: ${worker.workspaceProvider}`,
    `Workspace path: ${worker.workspaceRef ?? "(not prepared)"}`,
    `Branch: ${worker.branchName ?? "(none)"}`,
    `File scopes: ${(worker.fileScopes ?? []).join(", ") || "(none)"}`,
    `Depends on: ${(worker.dependsOn ?? []).join(", ") || "(none)"}`,
  ].join("\n");
}

async function captureWorkerGitDiff(
  workspacePath: string,
  baseRef: string | null,
) {
  if (!baseRef) {
    const changedFiles = await captureUncommittedChangedFiles(workspacePath);
    const patch = await execGit(["diff"], workspacePath);
    return {
      changedFiles,
      stat: null,
      patch: patch.exitCode === 0 ? patch.stdout.trim() : null,
      error: patch.exitCode === 0 ? null : patch.stderr.trim() || null,
    };
  }

  const lastCommitFiles = await execGit(
    ["diff", "--name-only", baseRef, "HEAD"],
    workspacePath,
  );
  const changedFiles =
    lastCommitFiles.exitCode === 0
      ? lastCommitFiles.stdout
          .split(/\r?\n/)
          .map((file) => file.trim())
          .filter(Boolean)
      : await captureUncommittedChangedFiles(workspacePath);
  const stat = await execGit(
    ["diff", "--stat", baseRef, "HEAD"],
    workspacePath,
  );
  let patch = await execGit(["diff", baseRef, "HEAD"], workspacePath);
  if (patch.exitCode !== 0) {
    patch = await execGit(["diff"], workspacePath);
  }

  return {
    changedFiles,
    stat: stat.exitCode === 0 ? stat.stdout.trim() : null,
    patch: patch.exitCode === 0 ? patch.stdout.trim() : null,
    error:
      lastCommitFiles.exitCode === 0 || changedFiles.length > 0
        ? null
        : lastCommitFiles.stderr.trim() || null,
  };
}

async function captureGitHead(workspacePath: string) {
  const result = await execGit(["rev-parse", "HEAD"], workspacePath);
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

async function captureUncommittedChangedFiles(workspacePath: string) {
  const result = await execGit(["diff", "--name-only"], workspacePath);
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
}

function getMetadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
) {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function isNodeErrorCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
