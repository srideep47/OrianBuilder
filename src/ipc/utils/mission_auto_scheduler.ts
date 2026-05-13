import type { IpcMainInvokeEvent } from "electron";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { apps, missions, missionWorkers } from "@/db/schema";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { readSettings } from "@/main/settings";
import { getOrianBuilderAppPath } from "@/paths/paths";
import type { Mission, MissionWorker } from "@/ipc/types/mission";
import { logMissionEvent } from "@/ipc/utils/mission_utils";
import {
  buildWorkerLifecycleMetadata,
  mergeWorkerMetadata,
  selectDispatchableWorkers,
} from "@/ipc/utils/mission_workers";
import { getMissionWorkspaceProvider } from "@/ipc/utils/mission_workspace_provider";

const DEFAULT_MAX_PARALLEL_WORKERS = 3;
const MAX_PARALLEL_WORKERS_CAP = 8;
const MAX_AUTO_ADVANCE_ITERATIONS = 20;

export type MissionAutoRunReadyWorkers = (input: {
  event: IpcMainInvokeEvent;
  missionId: number;
  limit: number;
  parallel: boolean;
}) => Promise<(typeof missionWorkers.$inferSelect)[]>;

export type MissionAutoAdvanceResult = {
  missionId: number;
  skipped: boolean;
  reason?: string;
  dispatchedWorkerKeys: string[];
  preparedWorkerKeys: string[];
  startedWorkerKeys: string[];
};

type AutoAdvanceAction =
  | { type: "skip"; reason: string }
  | { type: "dispatch"; workerKeys: string[] }
  | { type: "prepare"; workerKeys: string[] }
  | { type: "run"; workerKeys: string[] }
  | { type: "idle"; reason: string };

const missionLocks = new Map<number, Promise<MissionAutoAdvanceResult>>();

function clampParallelism(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_MAX_PARALLEL_WORKERS;
  return Math.max(
    1,
    Math.min(MAX_PARALLEL_WORKERS_CAP, Math.floor(value ?? 0)),
  );
}

function isAutoMission(
  mission: Pick<Mission, "autonomyProfile" | "status" | "chatId">,
) {
  return (
    mission.chatId !== null &&
    (mission.autonomyProfile === "trusted-workspace" ||
      mission.autonomyProfile === "full-autopilot-sandbox") &&
    (mission.status === "queued" || mission.status === "running")
  );
}

export function getMissionAutoAdvanceAction(input: {
  mission: Pick<Mission, "autonomyProfile" | "status" | "chatId">;
  workers: Pick<
    MissionWorker,
    "workerKey" | "status" | "dependsOn" | "workspaceRef"
  >[];
}): AutoAdvanceAction {
  if (!isAutoMission(input.mission)) {
    return { type: "skip", reason: "mission_not_auto_advanceable" };
  }

  const dispatchableWorkers = selectDispatchableWorkers(input.workers);
  const queuedWorkerKeys = dispatchableWorkers
    .filter((worker) => worker.status === "queued")
    .map((worker) => worker.workerKey);
  if (queuedWorkerKeys.length > 0) {
    return { type: "dispatch", workerKeys: queuedWorkerKeys };
  }

  const unpreparedWorkerKeys = dispatchableWorkers
    .filter((worker) => worker.status === "ready" && !worker.workspaceRef)
    .map((worker) => worker.workerKey);
  if (unpreparedWorkerKeys.length > 0) {
    return { type: "prepare", workerKeys: unpreparedWorkerKeys };
  }

  const runnableWorkerKeys = dispatchableWorkers
    .filter((worker) => worker.status === "ready" && worker.workspaceRef)
    .map((worker) => worker.workerKey);
  if (runnableWorkerKeys.length > 0) {
    return { type: "run", workerKeys: runnableWorkerKeys };
  }

  return { type: "idle", reason: "no_auto_action_available" };
}

export async function maybeAutoAdvanceMission(
  missionId: number,
  options: {
    event?: IpcMainInvokeEvent;
    runReadyMissionWorkers?: MissionAutoRunReadyWorkers;
  } = {},
): Promise<MissionAutoAdvanceResult> {
  const existing = missionLocks.get(missionId);
  if (existing) return existing;

  const promise = runAutoAdvanceMission(missionId, options).finally(() => {
    missionLocks.delete(missionId);
  });
  missionLocks.set(missionId, promise);
  return promise;
}

async function runAutoAdvanceMission(
  missionId: number,
  options: {
    event?: IpcMainInvokeEvent;
    runReadyMissionWorkers?: MissionAutoRunReadyWorkers;
  },
): Promise<MissionAutoAdvanceResult> {
  const result: MissionAutoAdvanceResult = {
    missionId,
    skipped: false,
    dispatchedWorkerKeys: [],
    preparedWorkerKeys: [],
    startedWorkerKeys: [],
  };

  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
  });
  if (!mission) {
    throw new OrianBuilderError(
      `Mission not found: ${missionId}`,
      OrianBuilderErrorKind.NotFound,
    );
  }
  if (!isAutoMission(mission)) {
    return {
      ...result,
      skipped: true,
      reason: "mission_not_auto_advanceable",
    };
  }

  if (mission.status === "queued") {
    const now = new Date();
    const [updatedMission] = await db
      .update(missions)
      .set({ status: "running", updatedAt: now, startedAt: now })
      .where(and(eq(missions.id, mission.id), eq(missions.status, "queued")))
      .returning();
    if (updatedMission) {
      await logMissionEvent({
        missionId,
        eventType: "mission_auto_advance_started",
        summary: "Mission auto-advance started",
        metadata: {
          autonomyProfile: mission.autonomyProfile,
          previousStatus: mission.status,
        },
      });
    }
  }

  for (let i = 0; i < MAX_AUTO_ADVANCE_ITERATIONS; i += 1) {
    const workers = await db
      .select()
      .from(missionWorkers)
      .where(eq(missionWorkers.missionId, missionId))
      .orderBy(missionWorkers.createdAt);
    const action = getMissionAutoAdvanceAction({ mission, workers });

    if (action.type === "dispatch") {
      const updated = await autoDispatchWorkers(missionId, action.workerKeys);
      result.dispatchedWorkerKeys.push(...updated.map((w) => w.workerKey));
      if (updated.length > 0) continue;
      break;
    }

    if (action.type === "prepare") {
      const updated = await autoPrepareWorkerWorkspaces(
        mission,
        workers.filter((worker) =>
          action.workerKeys.includes(worker.workerKey),
        ),
      );
      result.preparedWorkerKeys.push(...updated.map((w) => w.workerKey));
      if (updated.length > 0) continue;
      break;
    }

    if (action.type === "run") {
      if (!options.event || !options.runReadyMissionWorkers) {
        return {
          ...result,
          skipped: true,
          reason: "run_ready_worker_callback_missing",
        };
      }

      const limit = clampParallelism(
        readSettings().maxParallelMissionWorkers ??
          DEFAULT_MAX_PARALLEL_WORKERS,
      );
      const workerKeys = action.workerKeys.slice(0, limit);
      await logMissionEvent({
        missionId,
        eventType: "mission_auto_run_triggered",
        summary: `Auto-running ${workerKeys.length} prepared worker${workerKeys.length === 1 ? "" : "s"}`,
        metadata: { workerKeys, limit, parallel: true },
      });
      result.startedWorkerKeys.push(...workerKeys);
      await options.runReadyMissionWorkers({
        event: options.event,
        missionId,
        limit,
        parallel: true,
      });
      continue;
    }

    if (action.type === "skip" || action.type === "idle") {
      result.reason = action.reason;
      break;
    }
  }

  return result;
}

async function autoDispatchWorkers(missionId: number, workerKeys: string[]) {
  const now = new Date();
  const updatedWorkers: (typeof missionWorkers.$inferSelect)[] = [];

  for (const workerKey of workerKeys) {
    const existingWorker = await db.query.missionWorkers.findFirst({
      where: and(
        eq(missionWorkers.missionId, missionId),
        eq(missionWorkers.workerKey, workerKey),
        eq(missionWorkers.status, "queued"),
      ),
    });
    if (!existingWorker) continue;
    const [worker] = await db
      .update(missionWorkers)
      .set({
        status: "ready",
        metadata: buildWorkerLifecycleMetadata({
          existing: existingWorker.metadata,
          status: "ready",
          reason: "auto_dispatch_dependencies_satisfied",
          now,
        }),
        updatedAt: now,
        completedAt: null,
      })
      .where(
        and(
          eq(missionWorkers.missionId, missionId),
          eq(missionWorkers.workerKey, workerKey),
          eq(missionWorkers.status, "queued"),
        ),
      )
      .returning();
    if (worker) updatedWorkers.push(worker);
  }

  if (updatedWorkers.length > 0) {
    await logMissionEvent({
      missionId,
      eventType: "mission_auto_dispatch_triggered",
      summary: `Auto-dispatched ${updatedWorkers.length} worker${updatedWorkers.length === 1 ? "" : "s"}`,
      metadata: {
        workerKeys: updatedWorkers.map((worker) => worker.workerKey),
        workerIds: updatedWorkers.map((worker) => worker.id),
      },
    });
  }

  return updatedWorkers;
}

async function autoPrepareWorkerWorkspaces(
  mission: typeof missions.$inferSelect,
  workers: (typeof missionWorkers.$inferSelect)[],
) {
  const appRecord = await db.query.apps.findFirst({
    where: eq(apps.id, mission.appId),
  });
  if (!appRecord) {
    throw new OrianBuilderError(
      `App not found for mission: ${mission.appId}`,
      OrianBuilderErrorKind.NotFound,
    );
  }

  const appPath = getOrianBuilderAppPath(appRecord.path);
  const updatedWorkers: (typeof missionWorkers.$inferSelect)[] = [];
  for (const existingWorker of workers) {
    const provider = getMissionWorkspaceProvider(
      existingWorker.workspaceProvider,
    );
    const prepared = await provider.prepare({
      appPath,
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
          autoPrepared: true,
        }),
        updatedAt: now,
      })
      .where(
        and(
          eq(missionWorkers.id, existingWorker.id),
          eq(missionWorkers.status, "ready"),
          isNull(missionWorkers.workspaceRef),
        ),
      )
      .returning();
    if (!worker) continue;
    updatedWorkers.push(worker);
    await logMissionEvent({
      missionId: mission.id,
      eventType: "mission_worker_workspace_prepared",
      summary: `Worker ${worker.workerKey} workspace auto-prepared`,
      body: prepared.promptPackage,
      metadata: {
        workerId: worker.id,
        workerKey: worker.workerKey,
        role: worker.role,
        workspaceProvider: worker.workspaceProvider,
        workspaceRef: worker.workspaceRef,
        branchName: worker.branchName,
        autoPrepared: true,
      },
    });
  }

  if (updatedWorkers.length > 0) {
    await logMissionEvent({
      missionId: mission.id,
      eventType: "mission_auto_prepare_triggered",
      summary: `Auto-prepared ${updatedWorkers.length} worker workspace${updatedWorkers.length === 1 ? "" : "s"}`,
      metadata: {
        workerKeys: updatedWorkers.map((worker) => worker.workerKey),
        workerIds: updatedWorkers.map((worker) => worker.id),
      },
    });
  }

  return updatedWorkers;
}
