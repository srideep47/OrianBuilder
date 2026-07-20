import { and, eq, inArray } from "drizzle-orm";
import log from "electron-log";

import { db } from "@/db";
import { missionRuns, missions, missionWorkers } from "@/db/schema";
import { readSettings } from "@/main/settings";
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
  autoResume: boolean;
}) {
  return {
    runId: input.run.id,
    chatId: input.run.chatId,
    messageId: input.run.messageId,
    recovery: input.autoResume ? "auto_resume_queued" : "paused_for_resume",
    autoResume: input.autoResume,
    recoveredAt: input.recoveredAt.toISOString(),
    interruptedRunStartedAt: input.run.startedAt.toISOString(),
    totalStepsExecuted: input.run.totalStepsExecuted,
  };
}

export function buildInterruptedWorkerRecoveryMetadata(input: {
  worker: InterruptedMissionWorker;
  recoveredAt: Date;
  autoResume: boolean;
}) {
  return {
    workerId: input.worker.id,
    workerKey: input.worker.workerKey,
    role: input.worker.role,
    workspaceProvider: input.worker.workspaceProvider,
    workspaceRef: input.worker.workspaceRef,
    branchName: input.worker.branchName,
    recovery: input.autoResume
      ? "auto_resume_queued"
      : "worker_failed_for_retry",
    autoResume: input.autoResume,
    recoveredAt: input.recoveredAt.toISOString(),
    interruptedWorkerStartedAt: input.worker.startedAt?.toISOString() ?? null,
    interruptedWorkerUpdatedAt: input.worker.updatedAt.toISOString(),
  };
}

function shouldAutoResume(input: {
  autoResumeSetting: boolean | undefined;
  autonomyProfile: string | null | undefined;
}): boolean {
  if (input.autoResumeSetting) return true;
  return (
    input.autonomyProfile === "trusted-workspace" ||
    input.autonomyProfile === "full-autopilot-sandbox"
  );
}

export function findOrphanedRunningMissionIds(input: {
  runningMissionIds: number[];
  runningRunMissionIds: number[];
  runningWorkerMissionIds: number[];
}): number[] {
  const missionsWithExecution = new Set([
    ...input.runningRunMissionIds,
    ...input.runningWorkerMissionIds,
  ]);
  return input.runningMissionIds.filter(
    (missionId) => !missionsWithExecution.has(missionId),
  );
}

export async function recoverInterruptedMissionsOnStartup() {
  const settings = readSettings();
  const autoResumeSetting = settings.autoResumeMissionsOnStartup === true;

  const interruptedRuns = await db
    .select()
    .from(missionRuns)
    .where(eq(missionRuns.status, "running"));

  const recoveredAt = new Date();
  const interruptedWorkers = await db
    .select()
    .from(missionWorkers)
    .where(eq(missionWorkers.status, "running"));
  const runningMissions = await db
    .select()
    .from(missions)
    .where(eq(missions.status, "running"));
  const orphanedMissionIds = findOrphanedRunningMissionIds({
    runningMissionIds: runningMissions.map((mission) => mission.id),
    runningRunMissionIds: interruptedRuns.map((run) => run.missionId),
    runningWorkerMissionIds: interruptedWorkers.map(
      (worker) => worker.missionId,
    ),
  });
  const missionIds = [
    ...new Set([
      ...interruptedRuns.map((run) => run.missionId),
      ...interruptedWorkers.map((worker) => worker.missionId),
      ...orphanedMissionIds,
    ]),
  ];

  if (missionIds.length === 0) {
    return {
      recoveredRunCount: 0,
      recoveredMissionCount: 0,
      recoveredWorkerCount: 0,
      autoResumedMissionIds: [] as number[],
    };
  }

  // Look up missions to determine per-mission auto-resume decisions.
  const affectedMissions = await db
    .select()
    .from(missions)
    .where(inArray(missions.id, missionIds));
  const missionById = new Map(
    affectedMissions.map((mission) => [mission.id, mission]),
  );

  const autoResumeMissionIds: number[] = [];
  const pauseMissionIds: number[] = [];
  for (const mission of affectedMissions) {
    if (mission.status !== "running") continue;
    if (orphanedMissionIds.includes(mission.id)) continue;
    if (
      shouldAutoResume({
        autoResumeSetting,
        autonomyProfile: mission.autonomyProfile,
      })
    ) {
      autoResumeMissionIds.push(mission.id);
    } else {
      pauseMissionIds.push(mission.id);
    }
  }

  if (autoResumeMissionIds.length > 0) {
    await db
      .update(missions)
      .set({
        status: "queued",
        updatedAt: recoveredAt,
      })
      .where(inArray(missions.id, autoResumeMissionIds));
  }
  if (pauseMissionIds.length > 0) {
    await db
      .update(missions)
      .set({
        status: "paused",
        updatedAt: recoveredAt,
      })
      .where(inArray(missions.id, pauseMissionIds));
  }
  if (orphanedMissionIds.length > 0) {
    await db
      .update(missions)
      .set({
        status: "failed",
        updatedAt: recoveredAt,
        completedAt: recoveredAt,
      })
      .where(inArray(missions.id, orphanedMissionIds));

    for (const missionId of orphanedMissionIds) {
      await logMissionEvent({
        missionId,
        eventType: "mission_startup_preflight_failed",
        summary: "Mission failed before an agent run started",
        body: "The app restarted while this mission was marked running, but no run or worker execution existed.",
        metadata: {
          recovery: "orphaned_running_mission",
          recoveredAt: recoveredAt.toISOString(),
        },
      }).catch((err) =>
        logger.warn(`Failed to log orphaned mission ${missionId}:`, err),
      );
    }
  }

  for (const run of interruptedRuns) {
    const mission = missionById.get(run.missionId);
    const autoResume = mission
      ? shouldAutoResume({
          autoResumeSetting,
          autonomyProfile: mission.autonomyProfile,
        })
      : false;
    const metadata = buildInterruptedRunRecoveryMetadata({
      run,
      recoveredAt,
      autoResume,
    });

    await finishMissionRun({
      runId: run.id,
      status: "cancelled",
      totalStepsExecuted: run.totalStepsExecuted,
      error: autoResume
        ? "Mission run was interrupted by app shutdown and queued for auto-resume."
        : "Mission run was interrupted by app shutdown or restart.",
      metadata,
    }).catch((err) =>
      logger.warn(`Failed to finish interrupted mission run ${run.id}:`, err),
    );

    await logMissionEvent({
      missionId: run.missionId,
      eventType: autoResume
        ? "mission_auto_resume_queued"
        : "mission_interrupted_recovered",
      summary: autoResume
        ? "Mission queued for auto-resume after app restart"
        : "Mission paused after app restart",
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
      summary: autoResume
        ? "Auto-resume queued after interrupted mission run"
        : "Recovered interrupted mission run",
      metadata,
    }).catch((err) =>
      logger.warn(
        `Failed to checkpoint interrupted mission recovery for run ${run.id}:`,
        err,
      ),
    );
  }

  for (const worker of interruptedWorkers) {
    const mission = missionById.get(worker.missionId);
    const autoResume = mission
      ? shouldAutoResume({
          autoResumeSetting,
          autonomyProfile: mission.autonomyProfile,
        })
      : false;
    const metadata = buildInterruptedWorkerRecoveryMetadata({
      worker,
      recoveredAt,
      autoResume,
    });
    const targetStatus: "queued" | "failed" = autoResume ? "queued" : "failed";
    const workerMetadata = buildWorkerLifecycleMetadata({
      existing: mergeWorkerMetadata(worker.metadata, metadata),
      status: targetStatus,
      reason: autoResume ? "app_restart_auto_resume" : "app_restart_recovery",
      now: recoveredAt,
    });

    await db
      .update(missionWorkers)
      .set({
        status: targetStatus,
        metadata: workerMetadata,
        updatedAt: recoveredAt,
        startedAt: autoResume ? null : worker.startedAt,
        completedAt: autoResume ? null : recoveredAt,
      })
      .where(eq(missionWorkers.id, worker.id))
      .catch((err) =>
        logger.warn(`Failed to recover interrupted worker ${worker.id}:`, err),
      );

    await logMissionEvent({
      missionId: worker.missionId,
      eventType: autoResume
        ? "mission_worker_auto_resume_queued"
        : "mission_worker_interrupted_recovered",
      summary: autoResume
        ? `Worker ${worker.workerKey} queued for auto-resume after app restart`
        : `Worker ${worker.workerKey} failed after app restart`,
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
    autoResumedMissionIds: autoResumeMissionIds,
  };
}

export async function findAutoResumableMissions(
  appId?: number,
): Promise<{ id: number; appId: number; chatId: number | null }[]> {
  const settings = readSettings();
  const autoResumeSetting = settings.autoResumeMissionsOnStartup === true;

  const queuedMissions = await db
    .select()
    .from(missions)
    .where(
      appId !== undefined
        ? and(eq(missions.status, "queued"), eq(missions.appId, appId))
        : eq(missions.status, "queued"),
    );

  return queuedMissions
    .filter((mission) =>
      shouldAutoResume({
        autoResumeSetting,
        autonomyProfile: mission.autonomyProfile,
      }),
    )
    .map((mission) => ({
      id: mission.id,
      appId: mission.appId,
      chatId: mission.chatId,
    }));
}
