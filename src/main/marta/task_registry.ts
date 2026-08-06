import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";
import log from "electron-log";
import { inArray } from "drizzle-orm";

import { getUserDataPath } from "@/paths/paths";
import { db } from "@/db";
import { missionWorkers } from "@/db/schema";
import {
  MartaTaskEventSchema,
  MartaTaskSchema,
  martaEvents,
  type MartaEvidence,
  type MartaTask,
  type MartaTaskEvent,
  type MartaTaskEventType,
} from "@/ipc/types/marta";
import type { ClaudeEvent } from "@/ipc/types/claude_code";
import {
  TaskNarrationCoordinator,
  type ProactiveNarration,
} from "./task_narrator";
import { deriveMissionTaskTransition } from "./task_status";
import { verifyCodingTaskAcceptance } from "./task_acceptance_verifier";

const logger = log.scope("marta-tasks");
const FILE_NAME = "marta-tasks.json";
const EVENT_FILE_NAME = "marta-task-events.jsonl";
const MAX_TASKS = 100;
const MAX_EVENTS = 2_000;

let tasks = new Map<string, MartaTask>();
let loaded = false;
let loadPromise: Promise<void> | null = null;
let writeChain = Promise.resolve();
let taskEvents: MartaTaskEvent[] = [];
let eventsLoaded = false;
let eventWriteChain = Promise.resolve();
const taskListeners = new Set<(task: MartaTask) => void>();
const acceptanceVerifications = new Map<string, Promise<MartaTask | null>>();

function taskFilePath(): string {
  return path.join(getUserDataPath(), FILE_NAME);
}

function eventFilePath(): string {
  return path.join(getUserDataPath(), EVENT_FILE_NAME);
}

function broadcast(task: MartaTask): void {
  for (const listener of taskListeners) listener(task);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(martaEvents.taskUpdate.channel, task);
    }
  }
}

export function subscribeMartaTaskUpdates(
  listener: (task: MartaTask) => void,
): () => void {
  taskListeners.add(listener);
  return () => taskListeners.delete(listener);
}

export function waitForMartaTask(
  id: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MartaTask> {
  const terminal = new Set(["succeeded", "failed", "cancelled"]);
  const current = tasks.get(id);
  if (current && terminal.has(current.status)) return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    const finish = (task?: MartaTask, error?: Error): void => {
      unsubscribe();
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (task) resolve(task);
    };
    const unsubscribe = subscribeMartaTaskUpdates((task) => {
      if (task.id === id && terminal.has(task.status)) finish(task);
    });
    const timeout = setTimeout(
      () => finish(undefined, new Error(`Timed out waiting for task ${id}.`)),
      options.timeoutMs ?? 30 * 60_000,
    );
    const abort = (): void =>
      finish(undefined, new Error(`Cancelled while waiting for task ${id}.`));
    options.signal?.addEventListener("abort", abort, { once: true });
  });
}

function broadcastTaskEvent(taskEvent: MartaTaskEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(martaEvents.taskEvent.channel, taskEvent);
    }
  }
}

function broadcastNarration(narration: ProactiveNarration): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(martaEvents.proactiveNarration.channel, narration);
    }
  }
}

const narrator = new TaskNarrationCoordinator(broadcastNarration);

function queueWrite(): void {
  const snapshot = JSON.stringify(
    listMartaTasks({ limit: MAX_TASKS }),
    null,
    2,
  );
  writeChain = writeChain
    .then(async () => {
      await fs.mkdir(path.dirname(taskFilePath()), { recursive: true });
      const temporary = `${taskFilePath()}.tmp`;
      await fs.writeFile(temporary, snapshot, "utf8");
      await fs.rename(temporary, taskFilePath());
    })
    .catch((error) => logger.warn("Could not persist Marta tasks:", error));
}

async function loadMartaTaskEvents(): Promise<void> {
  if (eventsLoaded) return;
  try {
    const raw = await fs.readFile(eventFilePath(), "utf8");
    const parsed: MartaTaskEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = MartaTaskEventSchema.safeParse(JSON.parse(line));
        if (event.success) parsed.push(event.data);
      } catch {
        // A torn final line after a power loss must not discard earlier events.
      }
    }
    taskEvents = parsed.slice(-MAX_EVENTS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("Could not load Marta task events:", error);
    }
  } finally {
    eventsLoaded = true;
  }
}

function persistTaskEvent(taskEvent: MartaTaskEvent): void {
  const line = `${JSON.stringify(taskEvent)}\n`;
  eventWriteChain = eventWriteChain
    .then(async () => {
      await fs.mkdir(path.dirname(eventFilePath()), { recursive: true });
      await fs.appendFile(eventFilePath(), line, "utf8");
    })
    .catch((error) =>
      logger.warn("Could not persist Marta task event:", error),
    );
}

export function appendMartaTaskEvent(
  input: Omit<MartaTaskEvent, "eventId" | "timestamp"> &
    Partial<Pick<MartaTaskEvent, "eventId" | "timestamp">>,
): MartaTaskEvent {
  const taskEvent = MartaTaskEventSchema.parse({
    ...input,
    eventId: input.eventId ?? randomUUID(),
    timestamp: input.timestamp ?? Date.now(),
  });
  taskEvents.push(taskEvent);
  if (taskEvents.length > MAX_EVENTS) {
    taskEvents.splice(0, taskEvents.length - MAX_EVENTS);
  }
  persistTaskEvent(taskEvent);
  broadcastTaskEvent(taskEvent);
  narrator.accept(taskEvent, tasks.get(taskEvent.taskId));
  return taskEvent;
}

export function listMartaTaskEvents(
  options: {
    taskId?: string;
    goalId?: string;
    after?: number;
    limit?: number;
  } = {},
): MartaTaskEvent[] {
  return taskEvents
    .filter(
      (event) =>
        (!options.taskId || event.taskId === options.taskId) &&
        (!options.goalId || event.goalId === options.goalId) &&
        (options.after === undefined || event.timestamp > options.after),
    )
    .slice(-(options.limit ?? 200))
    .map((event) => ({
      ...event,
      evidence: event.evidence?.map((item) => ({ ...item })),
      resourceUsage: event.resourceUsage
        ? { ...event.resourceUsage }
        : undefined,
    }));
}

async function reconcilePersistedLocalTasks(): Promise<void> {
  const missionIds = [...tasks.values()]
    .filter((task) => task.kind === "local")
    .map((task) => Number(task.runtimeId))
    .filter(Number.isFinite);
  if (missionIds.length === 0) return;

  try {
    const workers = await db
      .select({
        missionId: missionWorkers.missionId,
        status: missionWorkers.status,
      })
      .from(missionWorkers)
      .where(inArray(missionWorkers.missionId, missionIds));
    const byMission = new Map<
      number,
      Array<(typeof workers)[number]["status"]>
    >();
    for (const worker of workers) {
      const statuses = byMission.get(worker.missionId) ?? [];
      statuses.push(worker.status);
      byMission.set(worker.missionId, statuses);
    }

    const completedNeedingVerification: string[] = [];
    for (const task of tasks.values()) {
      if (task.kind !== "local") continue;
      const statuses = byMission.get(Number(task.runtimeId));
      if (!statuses?.length) continue;
      const failed = statuses.includes("failed");
      const active = statuses.some((status) =>
        ["queued", "ready", "running"].includes(status),
      );
      const waiting = statuses.includes("blocked");
      const cancelled = statuses.every((status) => status === "cancelled");
      const succeeded = statuses.every((status) => status === "completed");
      if (
        succeeded &&
        task.acceptanceTarget &&
        task.acceptanceBaseline &&
        !task.acceptanceDecision?.accepted
      ) {
        tasks.set(task.id, {
          ...task,
          status: "running",
          phase: "Verifying Orion acceptance evidence",
          error: undefined,
          completedAt: undefined,
          updatedAt: Date.now(),
        });
        completedNeedingVerification.push(task.id);
        continue;
      }
      const status = failed
        ? "failed"
        : active
          ? "running"
          : waiting
            ? "waiting"
            : cancelled
              ? "cancelled"
              : succeeded
                ? "succeeded"
                : task.status;
      const terminal = ["failed", "cancelled", "succeeded"].includes(status);
      tasks.set(task.id, {
        ...task,
        status,
        ...(failed
          ? {
              phase: "Local coding worker failed",
              error:
                task.error ??
                "The local coding worker failed. Open its workspace for the runtime report.",
            }
          : {}),
        ...(terminal
          ? { completedAt: task.completedAt ?? Date.now() }
          : { completedAt: undefined }),
        updatedAt: Date.now(),
      });
    }
    await Promise.all(
      completedNeedingVerification.map((id) =>
        verifyMartaTaskAcceptance(id, true),
      ),
    );
  } catch (error) {
    logger.warn("Could not reconcile local Marta tasks:", error);
  }
}

export async function loadMartaTasks(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = JSON.parse(await fs.readFile(taskFilePath(), "utf8"));
      const parsed = MartaTaskSchema.array().safeParse(raw);
      if (parsed.success) {
        const now = Date.now();
        tasks = new Map(
          parsed.data.map((task) => {
            // A terminal worker report may be followed by an informational
            // event such as diff capture. Older builds incorrectly reopened
            // those tasks as `running` while leaving `completedAt` intact.
            const reopenedTerminal =
              task.status === "running" && task.completedAt !== undefined;
            const interrupted = ["queued", "running", "waiting"].includes(
              task.status,
            );
            const restored: MartaTask = reopenedTerminal
              ? {
                  ...task,
                  status: task.error ? "failed" : "succeeded",
                  updatedAt: now,
                }
              : interrupted
                ? {
                    ...task,
                    status: "cancelled",
                    phase: "Interrupted when Orion closed",
                    completedAt: now,
                    updatedAt: now,
                  }
                : task;
            return [restored.id, restored];
          }),
        );
        await reconcilePersistedLocalTasks();
        await loadMartaTaskEvents();
        // Persist restart recovery/migrations so the same stale state is not
        // reinterpreted on every launch.
        queueWrite();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn("Could not load Marta tasks:", error);
      }
    } finally {
      await loadMartaTaskEvents();
      loaded = true;
    }
  })();
  return loadPromise;
}

export function listMartaTasks(
  options: {
    includeCompleted?: boolean;
    limit?: number;
  } = {},
): MartaTask[] {
  const terminal = new Set(["succeeded", "failed", "cancelled"]);
  return [...tasks.values()]
    .filter(
      (task) =>
        options.includeCompleted !== false || !terminal.has(task.status),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, options.limit ?? 30);
}

export function getMartaTask(id: string): MartaTask | null {
  return tasks.get(id) ?? null;
}

export function createMartaTask(
  input: Omit<MartaTask, "completedSteps" | "createdAt" | "updatedAt"> &
    Partial<Pick<MartaTask, "completedSteps" | "createdAt" | "updatedAt">>,
): MartaTask {
  const now = Date.now();
  const task: MartaTask = {
    ...input,
    completedSteps: input.completedSteps ?? 0,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  tasks.set(task.id, task);
  queueWrite();
  broadcast(task);
  appendMartaTaskEvent({
    taskId: task.id,
    goalId: task.goalId,
    workstreamId: task.workstreamId,
    attempt: task.attempt,
    actor: task.workerLabel,
    type: task.status === "queued" ? "queued" : "created",
    status: task.status,
    phase: task.phase,
    progress: task.progress,
    publicSummary: task.phase ?? `${task.title} was created.`,
  });
  return task;
}

function eventTypeForPatch(
  current: MartaTask,
  next: MartaTask,
  patch: Partial<MartaTask>,
): MartaTaskEventType | null {
  if (next.status !== current.status) {
    switch (next.status) {
      case "queued":
        return current.status === "failed" ? "retrying" : "queued";
      case "running":
        return current.status === "queued" ? "started" : "checkpoint";
      case "waiting":
        return "blocked";
      case "succeeded":
        return "succeeded";
      case "failed":
        return "failed";
      case "cancelled":
        return "cancelled";
    }
  }
  if (
    patch.evidence &&
    patch.evidence.length > (current.evidence?.length ?? 0)
  ) {
    return "artifact";
  }
  if (patch.resourceUsage) return "resource";
  if (patch.lastHeartbeatAt) return "heartbeat";
  if (patch.phase?.toLowerCase().includes("verif")) return "verifying";
  if (
    patch.phase !== undefined ||
    patch.activeTool !== undefined ||
    patch.activeFile !== undefined ||
    patch.progress !== undefined ||
    patch.completedSteps !== undefined
  ) {
    return "checkpoint";
  }
  return null;
}

export function updateMartaTask(
  id: string,
  patch: Partial<MartaTask>,
): MartaTask | null {
  const current = tasks.get(id);
  if (!current) return null;
  const terminal = ["succeeded", "failed", "cancelled"].includes(
    current.status,
  );
  const wouldReopen =
    terminal &&
    patch.status !== undefined &&
    !["succeeded", "failed", "cancelled"].includes(patch.status);
  const safePatch = wouldReopen
    ? { ...patch, status: current.status, completedAt: current.completedAt }
    : patch;
  const task = {
    ...current,
    ...safePatch,
    id: current.id,
    updatedAt: Date.now(),
  };
  tasks.set(id, task);
  queueWrite();
  broadcast(task);
  const type = eventTypeForPatch(current, task, safePatch);
  if (type) {
    appendMartaTaskEvent({
      taskId: task.id,
      goalId: task.goalId,
      workstreamId: task.workstreamId,
      attempt: task.attempt,
      actor: task.workerLabel,
      type,
      status: task.status,
      phase: task.phase,
      progress: task.progress,
      publicSummary:
        task.error ??
        task.blockedReason ??
        task.phase ??
        `${task.title} updated.`,
      evidence: safePatch.evidence,
      resourceUsage: safePatch.resourceUsage,
    });
  }
  return task;
}

export function recordMartaTaskEvidence(
  id: string,
  evidence: MartaEvidence,
  patch: Partial<MartaTask> = {},
): MartaTask | null {
  const current = tasks.get(id);
  if (!current) return null;
  const prior = current.evidence ?? [];
  const deduplicated = prior.filter((item) => item.id !== evidence.id);
  return updateMartaTask(id, {
    ...patch,
    evidence: [...deduplicated, evidence].slice(-50),
  });
}

function acceptanceEvidenceForTask(
  task: MartaTask,
  result: Awaited<ReturnType<typeof verifyCodingTaskAcceptance>>,
): MartaEvidence[] {
  const now = Date.now();
  const changed = result.evidence.observedChangedFiles;
  const relevant = result.decision.relevantChangedFiles;
  const diffEvidence: MartaEvidence = {
    id: `${task.id}:acceptance:diff`,
    kind: "diff",
    label: `${changed.length} host-observed file change${changed.length === 1 ? "" : "s"}`,
    ok:
      task.acceptanceTarget?.requireChangedFiles !== true ||
      relevant.length > 0,
    path: relevant[0],
    detail:
      changed.length > 0
        ? changed.slice(0, 20).join(", ")
        : "No project files changed after the worker started.",
    timestamp: now,
  };
  const checks: MartaEvidence[] = result.evidence.checks.map((check) => ({
    id: `${task.id}:acceptance:${check.check}`,
    kind:
      check.check === "build"
        ? "build"
        : check.check === "preview"
          ? "preview"
          : check.check === "visual"
            ? "screenshot"
            : "test",
    label: `${check.check} ${check.status}`,
    ok: check.status === "passed",
    uri: check.artifact,
    detail:
      [check.command, check.detail].filter(Boolean).join("\n") || undefined,
    timestamp: check.observedAt ?? now,
  }));
  return [diffEvidence, ...checks];
}

/**
 * Turn an optimistic worker terminal signal into a host-certified result.
 * Concurrent/duplicate terminal events share one verification run.
 */
export function verifyMartaTaskAcceptance(
  id: string,
  workerReportedSuccess: boolean,
): Promise<MartaTask | null> {
  const existing = acceptanceVerifications.get(id);
  if (existing) return existing;

  const verification = (async (): Promise<MartaTask | null> => {
    const task = tasks.get(id);
    if (!task) return null;
    if (!task.acceptanceTarget || !task.acceptanceBaseline) {
      return updateMartaTask(id, {
        status: "failed",
        phase: "Acceptance verification unavailable",
        activeTool: undefined,
        requiresAttention: true,
        error:
          "Orion rejected the worker completion because no pre-task workspace baseline was captured.",
        completedAt: Date.now(),
      });
    }

    updateMartaTask(id, {
      status: "running",
      phase: "Verifying Orion acceptance evidence",
      activeTool: "Orion verifier",
      completedAt: undefined,
    });
    try {
      const result = await verifyCodingTaskAcceptance({
        target: task.acceptanceTarget,
        baseline: task.acceptanceBaseline,
        workerReportedSuccess,
        appId: task.appId,
      });
      const generatedEvidence = acceptanceEvidenceForTask(task, result);
      const priorEvidence = (tasks.get(id)?.evidence ?? []).filter(
        (item) => !generatedEvidence.some((next) => next.id === item.id),
      );
      const checkSummary =
        result.evidence.checks.length > 0
          ? result.evidence.checks
              .map((check) => `${check.check}: ${check.status}`)
              .join(", ")
          : "No executable checks were required";
      const rejectionReasons = [
        ...result.decision.failedChecks.map((check) => `${check} failed`),
        ...result.decision.missingEvidence,
      ];
      return updateMartaTask(id, {
        status: result.decision.accepted ? "succeeded" : "failed",
        phase: result.decision.accepted
          ? "Completed and verified by Orion"
          : "Orion acceptance failed",
        activeTool: undefined,
        progress: result.decision.accepted ? 1 : task.progress,
        testSummary: checkSummary,
        requiresAttention: !result.decision.accepted,
        acceptanceEvidence: result.evidence,
        acceptanceDecision: result.decision,
        evidence: [...priorEvidence, ...generatedEvidence].slice(-50),
        error: result.decision.accepted
          ? undefined
          : `Orion rejected the worker completion: ${rejectionReasons.join(", ") || "required evidence was not satisfied"}.`,
        completedAt: Date.now(),
      });
    } catch (error) {
      return updateMartaTask(id, {
        status: "failed",
        phase: "Acceptance verification failed",
        activeTool: undefined,
        requiresAttention: true,
        error: `Orion could not verify the worker result: ${error instanceof Error ? error.message : String(error)}`,
        completedAt: Date.now(),
      });
    }
  })().finally(() => acceptanceVerifications.delete(id));

  acceptanceVerifications.set(id, verification);
  return verification;
}

export function heartbeatMartaTask(
  id: string,
  patch: Pick<MartaTask, "phase" | "progress" | "resourceUsage"> = {},
): MartaTask | null {
  return updateMartaTask(id, { ...patch, lastHeartbeatAt: Date.now() });
}

/** Ask every open Stage to choose a worker for an asynchronously-ready job. */
export function broadcastMartaDelegationChoice(choice: {
  requestId: string;
  appId: number;
  goal: string;
  readOnly: boolean;
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(martaEvents.delegationChoice.channel, choice);
    }
  }
}

export function updateMartaTaskFromClaudeEvent(
  turnId: string,
  event: ClaudeEvent,
): MartaTask | null {
  const id = `claude:${turnId}`;
  switch (event.kind) {
    case "session":
      return updateMartaTask(id, {
        status: "running",
        phase: "Claude session connected",
        model: event.model,
      });
    case "thinking":
      return updateMartaTask(id, { status: "running", phase: "Reasoning" });
    case "text":
      return updateMartaTask(id, {
        status: "running",
        phase: "Writing response",
      });
    case "tool-start":
      return updateMartaTask(id, {
        status: "running",
        phase: `Running ${event.name}`,
        activeTool: event.name,
      });
    case "tool-end": {
      const task = tasks.get(id);
      return updateMartaTask(id, {
        status: event.ok ? "running" : "waiting",
        phase: event.ok
          ? `Finished ${task?.activeTool ?? "tool"}`
          : "Tool needs attention",
        activeTool: undefined,
        completedSteps: (task?.completedSteps ?? 0) + 1,
      });
    }
    case "permission":
      return updateMartaTask(id, {
        status: "waiting",
        phase: `Waiting to use ${event.name}`,
        activeTool: event.name,
      });
    case "usage":
      return updateMartaTask(id, {
        costUsd: event.usage.costUsd,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
      });
    case "done":
      if (event.ok) {
        return updateMartaTask(id, {
          status: "running",
          phase: "Verifying Orion acceptance evidence",
          activeTool: "Orion verifier",
          error: undefined,
          completedAt: undefined,
        });
      }
      return updateMartaTask(id, {
        status: "failed",
        phase: "Claude Code failed",
        activeTool: undefined,
        error: event.error,
        completedAt: Date.now(),
      });
  }
}

export function updateMartaTaskFromMissionEvent(input: {
  missionId: number;
  eventType: string;
  summary: string;
  metadata?: Record<string, unknown> | null;
}): void {
  const id = `mission:${input.missionId}`;
  if (!tasks.has(id)) return;
  const current = tasks.get(id);
  if (!current) return;
  const transition = deriveMissionTaskTransition({
    currentStatus: current.status,
    eventType: input.eventType,
    metadata: input.metadata,
  });
  if (transition.completedSignal) {
    if (["succeeded", "failed", "cancelled"].includes(current.status)) return;
    updateMartaTask(id, {
      status: "running",
      phase: "Verifying Orion acceptance evidence",
      activeTool: "Orion verifier",
      error: undefined,
      completedAt: undefined,
    });
    void verifyMartaTaskAcceptance(id, true);
    return;
  }
  if (acceptanceVerifications.has(id) && !transition.failedSignal) return;
  updateMartaTask(id, {
    status: transition.status,
    phase: input.summary,
    ...(transition.failedSignal
      ? {
          error:
            typeof input.metadata?.error === "string"
              ? input.metadata.error
              : input.summary,
        }
      : {}),
    ...(transition.failedSignal ? { completedAt: Date.now() } : {}),
  });
}

export function _resetMartaTasksForTests(): void {
  tasks = new Map();
  taskEvents = [];
  eventsLoaded = true;
  loaded = true;
  loadPromise = Promise.resolve();
  acceptanceVerifications.clear();
}
