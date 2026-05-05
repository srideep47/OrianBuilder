import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { missionTasks, missions } from "@/db/schema";
import type { AgentTodo } from "@/ipc/types";
import { logMissionEvent } from "./mission_utils";

export type MissionTaskSyncRow = {
  externalId: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
  orderIndex: number;
  completedAt: Date | null;
};

export function buildMissionTaskSyncRows(
  todos: AgentTodo[],
  now: Date,
): MissionTaskSyncRow[] {
  return todos.map((todo, index) => ({
    externalId: todo.id,
    title: todo.content,
    status: todo.status,
    orderIndex: index,
    completedAt: todo.status === "completed" ? now : null,
  }));
}

export async function syncMissionTasksFromTodos(input: {
  missionId: number | undefined;
  todos: AgentTodo[];
}) {
  const { missionId, todos } = input;
  if (missionId === undefined) {
    return;
  }

  const now = new Date();
  if (todos.length === 0) {
    await db.delete(missionTasks).where(eq(missionTasks.missionId, missionId));
    await touchMission(missionId, now);
    await logMissionEvent({
      missionId,
      eventType: "mission_tasks_cleared",
      summary: "Mission tasks cleared",
    });
    return;
  }

  const rows = buildMissionTaskSyncRows(todos, now);
  const existingTasks = await db
    .select()
    .from(missionTasks)
    .where(eq(missionTasks.missionId, missionId));
  const existingByExternalId = new Map(
    existingTasks.map((task) => [task.externalId, task]),
  );
  const currentExternalIds = new Set(rows.map((row) => row.externalId));

  for (const row of rows) {
    const existing = existingByExternalId.get(row.externalId);
    if (existing) {
      await db
        .update(missionTasks)
        .set({
          title: row.title,
          status: row.status,
          orderIndex: row.orderIndex,
          updatedAt: now,
          completedAt: row.completedAt,
        })
        .where(eq(missionTasks.id, existing.id));
      continue;
    }

    await db.insert(missionTasks).values({
      missionId,
      externalId: row.externalId,
      title: row.title,
      status: row.status,
      orderIndex: row.orderIndex,
      createdAt: now,
      updatedAt: now,
      completedAt: row.completedAt,
    });
  }

  for (const existing of existingTasks) {
    if (currentExternalIds.has(existing.externalId)) {
      continue;
    }
    await db
      .delete(missionTasks)
      .where(
        and(
          eq(missionTasks.missionId, missionId),
          eq(missionTasks.externalId, existing.externalId),
        ),
      );
  }

  await touchMission(missionId, now);
  const completed = rows.filter((row) => row.status === "completed").length;
  await logMissionEvent({
    missionId,
    eventType: "mission_tasks_updated",
    summary: `Mission tasks updated: ${completed}/${rows.length} completed`,
    metadata: {
      total: rows.length,
      completed,
      inProgress: rows.filter((row) => row.status === "in_progress").length,
      pending: rows.filter((row) => row.status === "pending").length,
    },
  });
}

async function touchMission(missionId: number, updatedAt: Date) {
  await db
    .update(missions)
    .set({ updatedAt })
    .where(eq(missions.id, missionId));
}
