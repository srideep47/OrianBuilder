import { and, eq, inArray } from "drizzle-orm";
import log from "electron-log";

import { db } from "@/db";
import { missionRuns, missions } from "@/db/schema";
import {
  createMissionCheckpoint,
  finishMissionRun,
  logMissionEvent,
} from "@/ipc/utils/mission_utils";

const logger = log.scope("mission_recovery");

export type InterruptedMissionRun = {
  id: number;
  missionId: number;
  chatId: number | null;
  messageId: number | null;
  totalStepsExecuted: number;
  startedAt: Date;
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

export async function recoverInterruptedMissionsOnStartup() {
  const interruptedRuns = await db
    .select()
    .from(missionRuns)
    .where(eq(missionRuns.status, "running"));

  if (interruptedRuns.length === 0) {
    return { recoveredRunCount: 0, recoveredMissionCount: 0 };
  }

  const recoveredAt = new Date();
  const missionIds = [...new Set(interruptedRuns.map((run) => run.missionId))];

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

  return {
    recoveredRunCount: interruptedRuns.length,
    recoveredMissionCount: missionIds.length,
  };
}
