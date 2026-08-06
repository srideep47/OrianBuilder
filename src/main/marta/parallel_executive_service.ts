import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";

import { MartaGoalSnapshotSchema } from "@/ipc/types/marta";
import { getUserDataPath } from "@/paths/paths";
import {
  ParallelExecutive,
  type ExecutiveEvent,
  type GoalDefinition,
  type GoalNodeDefinition,
  type GoalNodeResult,
  type GoalSnapshot,
} from "./goal_graph";
import { executeDelegate } from "./delegates_executor";
import { invokeAction, summariseResult } from "./invoke_action";
import {
  createMartaTask,
  getMartaTask,
  updateMartaTask,
  waitForMartaTask,
} from "./task_registry";

const logger = log.scope("marta-executive");
const FILE_NAME = "marta-goals.json";

function taskId(goalId: string, nodeId: string): string {
  return `goal:${goalId}:${nodeId}`;
}

function workerLabel(node: GoalNodeDefinition): string {
  if (node.operation === "delegate.code") return "Coding worker";
  if (node.operation === "delegate.research") return "Research worker";
  if (node.operation === "delegate.brain") return "Marta big brain";
  if (node.kind === "verification") return "Orion verifier";
  return node.kind === "delegate" ? "Marta delegate" : "Orion action";
}

function eventTaskStatus(
  event: ExecutiveEvent,
): "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" {
  switch (event.status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "waiting":
    case "paused":
      return "waiting";
    case "queued":
      return "queued";
    case "running":
    case "verifying":
      return "running";
  }
}

export class ParallelExecutiveService {
  private readonly executive: ParallelExecutive;
  private readonly readyPromise: Promise<void>;
  private writeChain = Promise.resolve();

  constructor() {
    this.executive = new ParallelExecutive(
      (node, context) => this.execute(node, context.signal),
      (event) => this.onExecutiveEvent(event),
    );
    this.readyPromise = this.restore();
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  async createGoal(input: {
    id?: string;
    title: string;
    userRequest: string;
    maxConcurrency?: number;
    nodes: GoalNodeDefinition[];
    start?: boolean;
  }): Promise<GoalSnapshot> {
    await this.ready();
    const definition: GoalDefinition = {
      id: input.id ?? randomUUID(),
      title: input.title,
      userRequest: input.userRequest,
      maxConcurrency: input.maxConcurrency,
      nodes: input.nodes,
    };
    const snapshot = this.executive.createGoal(definition);
    for (const node of snapshot.nodes) {
      createMartaTask({
        id: taskId(snapshot.id, node.id),
        kind: node.operation === "delegate.code" ? "mission" : "flow",
        title: node.title,
        goal: input.userRequest,
        goalId: snapshot.id,
        workstreamId: node.id,
        workerLabel: workerLabel(node),
        model:
          typeof node.input?.model === "string" ? node.input.model : undefined,
        effort:
          typeof node.input?.effort === "string"
            ? node.input.effort
            : undefined,
        priority: node.priority,
        attempt: 0,
        maxAttempts: node.maxAttempts,
        status: "queued",
        phase: "Waiting for dependencies and resources",
      });
    }
    this.persist();
    if (input.start !== false) void this.executive.runGoal(snapshot.id);
    return this.executive.getGoal(snapshot.id) ?? snapshot;
  }

  async listGoals(): Promise<GoalSnapshot[]> {
    await this.ready();
    return this.executive.listGoals();
  }

  async control(
    goalId: string,
    command:
      | { action: "pause" | "resume" | "cancel" }
      | { action: "prioritize"; nodeId: string; priority: number }
      | { action: "cancel-node"; nodeId: string },
  ): Promise<GoalSnapshot> {
    await this.ready();
    const snapshot = this.executive.control(goalId, command);
    this.persist();
    return snapshot;
  }

  private async execute(
    node: GoalNodeDefinition,
    signal: AbortSignal,
  ): Promise<GoalNodeResult> {
    if (node.kind === "verification" && node.operation === "task.status") {
      const id =
        typeof node.input?.taskId === "string" ? node.input.taskId : "";
      if (!id) {
        return {
          ok: false,
          verified: false,
          summary: "Verification has no task id.",
          error: "Acceptance verification failed: missing task id.",
        };
      }
      const current = getMartaTask(id);
      const task =
        current && ["succeeded", "failed", "cancelled"].includes(current.status)
          ? current
          : await waitForMartaTask(id, { signal });
      return {
        ok: task.status === "succeeded",
        verified: task.status === "succeeded",
        summary:
          task.status === "succeeded"
            ? `${task.title} passed its acceptance checks.`
            : `${task.title} ended as ${task.status}.`,
        error: task.error,
      };
    }

    if (node.kind === "action" || node.kind === "verification") {
      const result = await invokeAction(node.operation, node.input ?? {});
      return {
        ok: result.ok,
        verified: result.ok,
        summary: result.ok
          ? summariseResult(result.data, 600)
          : (result.error ?? `${node.operation} failed.`),
        error: result.error,
      };
    }

    const result = await executeDelegate({
      delegateId: node.operation,
      args: node.input ?? {},
      userText:
        typeof node.input?.userText === "string"
          ? node.input.userText
          : typeof node.input?.goal === "string"
            ? node.input.goal
            : node.title,
      signal,
    });
    const delegatedTaskId =
      "taskId" in result && typeof result.taskId === "string"
        ? result.taskId
        : null;
    if (result.ok && delegatedTaskId) {
      const delegated = await waitForMartaTask(delegatedTaskId, { signal });
      return {
        ok: delegated.status === "succeeded",
        verified: delegated.status === "succeeded",
        summary:
          delegated.status === "succeeded"
            ? `${delegated.title} completed and was verified.`
            : `${delegated.title} ended as ${delegated.status}.`,
        error: delegated.error,
      };
    }
    return {
      ok: result.ok,
      verified: result.ok,
      summary: result.summary,
      error: result.ok ? undefined : result.summary,
    };
  }

  private onExecutiveEvent(event: ExecutiveEvent): void {
    if (event.nodeId) {
      const id = taskId(event.goalId, event.nodeId);
      const current = getMartaTask(id);
      if (current) {
        const status = eventTaskStatus(event);
        updateMartaTask(id, {
          status,
          phase: event.summary,
          blockedReason: status === "waiting" ? event.summary : undefined,
          requiresAttention: status === "failed" || status === "waiting",
          attempt:
            event.type === "node-started"
              ? (current.attempt ?? 0) + 1
              : current.attempt,
          startedAt:
            event.type === "node-started"
              ? (current.startedAt ?? event.timestamp)
              : current.startedAt,
          completedAt: ["succeeded", "failed", "cancelled"].includes(status)
            ? event.timestamp
            : undefined,
        });
      }
    }
    this.persist();
  }

  private async restore(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath(), "utf8"));
      const parsed = MartaGoalSnapshotSchema.array().safeParse(raw);
      if (!parsed.success) {
        logger.warn("Ignoring invalid persisted Marta goals.");
        return;
      }
      for (const snapshot of parsed.data) this.executive.restoreGoal(snapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn("Could not restore Marta goals:", error);
      }
    }
  }

  private persist(): void {
    const snapshot = JSON.stringify(this.executive.listGoals(), null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath()), { recursive: true });
        const temporary = `${this.filePath()}.tmp`;
        await fs.writeFile(temporary, snapshot, "utf8");
        await fs.rename(temporary, this.filePath());
      })
      .catch((error) => logger.warn("Could not persist Marta goals:", error));
  }

  private filePath(): string {
    return path.join(getUserDataPath(), FILE_NAME);
  }
}

let singleton: ParallelExecutiveService | null = null;

export function getParallelExecutive(): ParallelExecutiveService {
  singleton ??= new ParallelExecutiveService();
  return singleton;
}

export function _resetParallelExecutiveForTests(): void {
  singleton = null;
}
