import { and, eq, inArray } from "drizzle-orm";
import log from "electron-log";

import { db } from "@/db";
import { missionRuns, missions, missionWorkers } from "@/db/schema";
import {
  createMissionCheckpoint,
  finishMissionRun,
  logMissionEvent,
} from "@/ipc/utils/mission_utils";
import {
  buildWorkerLifecycleMetadata,
  mergeWorkerMetadata,
} from "@/ipc/utils/mission_workers";

const logger = log.scope("mission_recovery");

export type InterruptedMissionRun = {
  id: number;
  missionId: number;
  chatId: number | null;
  messageId: number | null;
  totalStepsExecuted: number;
  startedAt: Date;
};

export type InterruptedMissionWorker = {
  id: number;
  missionId: number;
  workerKey: string;
  role: string;
  workspaceProvider: string;
  workspaceRef: string | null;
  branchName: string | null;
  metadata: Record<string, unknown> | null;
  startedAt: Date | null;
  updatedAt: Date;
};

export function buildInterruptedRunRecoveryMetadata(input: {
  run: InterruptedMissionRun;
  recoveredAt: Date;
}) {
  return {
    runId: input.run.id,
    chatId: input.run.chatId,
    messageId: input.run.messageId,
    recovery: "paused_for_resume",
    recoveredAt: input.recoveredAt.toISOString(),
    interruptedRunStartedAt: input.run.startedAt.toISOString(),
    totalStepsExecuted: input.run.totalStepsExecuted,
  };
}

export function buildInterruptedWorkerRecoveryMetadata(input: {
  worker: InterruptedMissionWorker;
  recoveredAt: Date;
}) {
  return {
    workerId: input.worker.id,
    workerKey: input.worker.workerKey,
    role: input.worker.role,
    workspaceProvider: input.worker.workspaceProvider,
    workspaceRef: input.worker.workspaceRef,
    branchName: input.worker.branchName,
    recovery: "worker_failed_for_retry",
    recoveredAt: input.recoveredAt.toISOString(),
    interruptedWorkerStartedAt: input.worker.startedAt?.toISOString() ?? null,
    interruptedWorkerUpdatedAt: input.worker.updatedAt.toISOString(),
  };
}

export async function recoverInterruptedMissionsOnStartup() {
  const interruptedRuns = await db
    .select()
    .from(missionRuns)
    .where(eq(missionRuns.status, "running"));

  const recoveredAt = new Date();
  const interruptedWorkers = await db
    .select()
    .from(missionWorkers)
    .where(eq(missionWorkers.status, "running"));
  const missionIds = [
    ...new Set([
      ...interruptedRuns.map((run) => run.missionId),
      ...interruptedWorkers.map((worker) => worker.missionId),
    ]),
  ];

  if (missionIds.length === 0) {
    return {
      recoveredRunCount: 0,
      recoveredMissionCount: 0,
      recoveredWorkerCount: 0,
    };
  }

  await db
    .update(missions)
    .set({
      status: "paused",
      updatedAt: recoveredAt,
    })
    .where(
      and(inArray(missions.id, missionIds), eq(missions.status, "running")),
    );

  for (const run of interruptedRuns) {
    const metadata = buildInterruptedRunRecoveryMetadata({
      run,
      recoveredAt,
    });

    await finishMissionRun({
      runId: run.id,
      status: "cancelled",
      totalStepsExecuted: run.totalStepsExecuted,
      error: "Mission run was interrupted by app shutdown or restart.",
      metadata,
    }).catch((err) =>
      logger.warn(`Failed to finish interrupted mission run ${run.id}:`, err),
    );

    await logMissionEvent({
      missionId: run.missionId,
      eventType: "mission_interrupted_recovered",
      summary: "Mission paused after app restart",
      metadata,
    }).catch((err) =>
      logger.warn(
        `Failed to log interrupted mission recovery for run ${run.id}:`,
        err,
      ),
    );

    await createMissionCheckpoint({
      missionId: run.missionId,
      runId: run.id,
      summary: "Recovered interrupted mission run",
      metadata,
    }).catch((err) =>
      logger.warn(
        `Failed to checkpoint interrupted mission recovery for run ${run.id}:`,
        err,
      ),
    );
  }

  for (const worker of interruptedWorkers) {
    const metadata = buildInterruptedWorkerRecoveryMetadata({
      worker,
      recoveredAt,
    });
    const workerMetadata = buildWorkerLifecycleMetadata({
      existing: mergeWorkerMetadata(worker.metadata, metadata),
      status: "failed",
      reason: "app_restart_recovery",
      now: recoveredAt,
    });

    await db
      .update(missionWorkers)
      .set({
        status: "failed",
        metadata: workerMetadata,
        updatedAt: recoveredAt,
        completedAt: recoveredAt,
      })
      .where(eq(missionWorkers.id, worker.id))
      .catch((err) =>
        logger.warn(`Failed to recover interrupted worker ${worker.id}:`, err),
      );

    await logMissionEvent({
      missionId: worker.missionId,
      eventType: "mission_worker_interrupted_recovered",
      summary: `Worker ${worker.workerKey} failed after app restart`,
      metadata,
    }).catch((err) =>
      logger.warn(
        `Failed to log interrupted worker recovery for worker ${worker.id}:`,
        err,
      ),
    );
  }

  return {
    recoveredRunCount: interruptedRuns.length,
    recoveredMissionCount: missionIds.length,
    recoveredWorkerCount: interruptedWorkers.length,
  };
}
