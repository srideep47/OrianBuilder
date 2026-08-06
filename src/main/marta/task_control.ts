/**
 * One place that knows how to stop, retry and reprioritise work.
 *
 * "Stop task two and give its resources to task one" is a single user intention.
 * Underneath, a Claude turn is cancelled through its own runtime, a local worker
 * through the mission database, and a graph node through the executive's
 * scheduler. If the renderer had to know which of those applies, the three would
 * drift — and the ones that got missed would look like a control that silently
 * does nothing, which is worse than a control that is absent.
 */

import log from "electron-log";

import type { MartaTask } from "@/ipc/types/marta";

import { callHandler } from "./invoke_action";
import { getParallelExecutive } from "./parallel_executive_service";
import { getMartaTask, updateMartaTask } from "./task_registry";

const logger = log.scope("marta-task-control");

export interface TaskControlResult {
  ok: boolean;
  summary: string;
}

export type TaskControlCommand =
  | { taskId: string; action: "stop" }
  | { taskId: string; action: "retry" }
  | { taskId: string; action: "prioritize"; priority: number };

function isTerminal(task: MartaTask): boolean {
  return ["succeeded", "failed", "cancelled"].includes(task.status);
}

/** Numeric mission id from a `mission:123` ledger id or a stored runtime id. */
function missionId(task: MartaTask): number | null {
  const raw = task.runtimeId ?? task.id.split(":")[1];
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

async function stopTask(task: MartaTask): Promise<TaskControlResult> {
  // A node inside a goal graph is cancelled by the scheduler, not by reaching
  // past it into the worker: the graph has to know, or its joins wait forever.
  if (task.goalId && task.workstreamId) {
    try {
      await getParallelExecutive().control(task.goalId, {
        action: "cancel-node",
        nodeId: task.workstreamId,
      });
      return { ok: true, summary: `Stopped ${task.title}.` };
    } catch (error) {
      logger.warn("Could not cancel a goal node:", error);
    }
  }

  if (task.kind === "claude") {
    const turnId = task.runtimeId;
    if (!turnId) {
      return { ok: false, summary: `${task.title} has no live Claude turn.` };
    }
    const result = await callHandler(
      "claude-code:cancel-turn",
      { turnId },
      { label: "marta.stop-task" },
    );
    if (!result.ok) {
      return { ok: false, summary: result.error ?? "Could not stop Claude." };
    }
    updateMartaTask(task.id, {
      status: "cancelled",
      phase: "Stopped at your request",
      activeTool: undefined,
      completedAt: Date.now(),
    });
    return { ok: true, summary: `Stopped ${task.title}.` };
  }

  const mission = missionId(task);
  if (mission === null) {
    return {
      ok: false,
      summary: `${task.title} has no runtime Orion can stop.`,
    };
  }
  const result = await callHandler(
    "mission:update-status",
    { missionId: mission, status: "cancelled" },
    { label: "marta.stop-task" },
  );
  if (!result.ok) {
    return {
      ok: false,
      summary: result.error ?? "Could not stop the mission.",
    };
  }
  updateMartaTask(task.id, {
    status: "cancelled",
    phase: "Stopped at your request",
    activeTool: undefined,
    completedAt: Date.now(),
  });
  return { ok: true, summary: `Stopped ${task.title}.` };
}

async function retryTask(task: MartaTask): Promise<TaskControlResult> {
  if (!isTerminal(task)) {
    return {
      ok: false,
      summary: `${task.title} is still running, so there is nothing to retry.`,
    };
  }

  if (task.goalId && task.workstreamId) {
    // The graph owns attempt budgets and dependency order; re-running a node
    // through it keeps the join and the retry limit meaningful.
    try {
      await getParallelExecutive().control(task.goalId, {
        action: "prioritize",
        nodeId: task.workstreamId,
        priority: (task.priority ?? 0) + 1,
      });
      await getParallelExecutive().control(task.goalId, { action: "resume" });
      return { ok: true, summary: `Queued another attempt at ${task.title}.` };
    } catch (error) {
      logger.warn("Could not retry a goal node:", error);
    }
  }

  const mission = missionId(task);
  if (mission !== null && task.kind !== "claude") {
    const workers = await callHandler(
      "mission:list-workers",
      { missionId: mission },
      { label: "marta.retry-task" },
    );
    const list = Array.isArray(workers.data)
      ? (workers.data as Array<{ id?: number; status?: string }>)
      : [];
    // Retry the ones that actually failed. Re-running a completed worker would
    // redo accepted work and could undo it.
    const failed = list.filter((worker) => worker.status === "failed");
    if (failed.length === 0) {
      return {
        ok: false,
        summary: `${task.title} has no failed worker to retry.`,
      };
    }
    for (const worker of failed) {
      if (typeof worker.id !== "number") continue;
      const retry = await callHandler(
        "mission:retry-worker",
        { workerId: worker.id },
        { label: "marta.retry-task" },
      );
      if (!retry.ok) {
        return {
          ok: false,
          summary: retry.error ?? "Could not retry the local worker.",
        };
      }
    }
    updateMartaTask(task.id, {
      status: "queued",
      phase: "Retrying at your request",
      error: undefined,
      requiresAttention: false,
      completedAt: undefined,
      attempt: (task.attempt ?? 0) + 1,
    });
    return {
      ok: true,
      summary: `Retrying ${failed.length} failed worker${failed.length === 1 ? "" : "s"} on ${task.title}.`,
    };
  }

  // A finished Claude turn cannot be resumed; a retry is a new delegation with
  // the same worker choice. Saying so is better than pretending to resume.
  return {
    ok: false,
    summary: `${task.title} finished, so a retry starts fresh. Say “${task.goal.slice(0, 60)}” again and I will run it with the same worker.`,
  };
}

async function prioritizeTask(
  task: MartaTask,
  priority: number,
): Promise<TaskControlResult> {
  if (!task.goalId || !task.workstreamId) {
    // Honest failure: a standalone task has no scheduler competing for it, so
    // there is no priority to change.
    updateMartaTask(task.id, { priority });
    return {
      ok: true,
      summary: `Noted ${task.title} as priority ${priority}. It is not part of a scheduled goal, so nothing was waiting on it.`,
    };
  }
  await getParallelExecutive().control(task.goalId, {
    action: "prioritize",
    nodeId: task.workstreamId,
    priority,
  });
  updateMartaTask(task.id, { priority });
  return { ok: true, summary: `${task.title} now runs ahead of its siblings.` };
}

export async function controlMartaTask(
  command: TaskControlCommand,
): Promise<TaskControlResult> {
  const task = getMartaTask(command.taskId);
  if (!task) {
    return { ok: false, summary: "That task is no longer in the ledger." };
  }

  switch (command.action) {
    case "stop":
      if (isTerminal(task)) {
        return {
          ok: true,
          summary: `${task.title} had already ${task.status}.`,
        };
      }
      return stopTask(task);
    case "retry":
      return retryTask(task);
    case "prioritize":
      return prioritizeTask(task, command.priority);
  }
}
