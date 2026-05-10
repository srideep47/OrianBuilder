import { and, desc, eq } from "drizzle-orm";
import log from "electron-log";

import { db } from "@/db";
import {
  apps,
  missionArtifacts,
  missionCheckpoints,
  missionEvents,
  missionRuns,
  missions,
  missionTasks,
  missionWorkers,
} from "@/db/schema";
import { getDyadAppPath } from "@/paths/paths";
import { createLoggedTypedHandler } from "./base";
import { missionContracts } from "../types/mission";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { logMissionEvent } from "../utils/mission_utils";
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

const logger = log.scope("mission_handlers");
const handle = createLoggedTypedHandler(logger);

async function getMissionOrThrow(missionId: number) {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
  });

  if (!mission) {
    throw new DyadError(
      `Mission not found: ${missionId}`,
      DyadErrorKind.NotFound,
    );
  }

  return mission;
}

async function getMissionWorkerOrThrow(workerId: number) {
  const worker = await db.query.missionWorkers.findFirst({
    where: eq(missionWorkers.id, workerId),
  });

  if (!worker) {
    throw new DyadError(
      `Mission worker not found: ${workerId}`,
      DyadErrorKind.NotFound,
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
            throw new DyadError(
              `Cannot complete mission until post-create verification passes. Missing: ${gateStatus.missingChecks.join(", ")}`,
              DyadErrorKind.Precondition,
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
      throw new DyadError(
        "Mission event was not recorded.",
        DyadErrorKind.Internal,
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
        throw new DyadError(
          `Only blocked, failed, cancelled, or stale running workers can be retried. Current status: ${existingWorker.status}`,
          DyadErrorKind.Precondition,
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
        throw new DyadError(
          `App not found for mission worker: ${mission.appId}`,
          DyadErrorKind.NotFound,
        );
      }

      const provider = getMissionWorkspaceProvider(
        existingWorker.workspaceProvider,
      );
      const prepared = await provider.prepare({
        appPath: getDyadAppPath(appRecord.path),
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
        throw new DyadError(
          `Worker ${existingWorker.workerKey} has no completion report to integrate.`,
          DyadErrorKind.Precondition,
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
}
