import type { MissionTask, MissionWorker } from "@/ipc/types/mission";

export const DEFAULT_WORKER_STALE_AFTER_MS = 15 * 60 * 1000;

export type WorkerConflict = {
  firstWorkerKey: string;
  secondWorkerKey: string;
  overlappingScopes: string[];
};

export type WorkerDependencyBlock = {
  workerKey: string;
  missingDependencies: string[];
  incompleteDependencies: string[];
};

export type StaleWorker = {
  workerKey: string;
  staleForMs: number;
};

export type WorkerOutputConflict = {
  firstWorkerKey: string;
  secondWorkerKey: string;
  overlappingFiles: string[];
};

export type WorkerIntegrationStatus = "pending" | "applied" | "rejected";

export type WorkerIntegrationPlan = {
  isReady: boolean;
  pendingWorkerKeys: string[];
  appliedWorkerKeys: string[];
  rejectedWorkerKeys: string[];
  conflicts: WorkerOutputConflict[];
};

export type MissionWorkerReportInput = {
  summary: string;
  changedFiles?: string[] | null;
  validation?: string | null;
  blockers?: string | null;
  artifacts?: string[] | null;
};

export type NormalizedMissionWorkerReport = {
  summary: string;
  changedFiles: string[];
  validation: string | null;
  blockers: string | null;
  artifacts: string[];
};

export type WorkerLifecycleMetadata = Record<string, unknown> | null;

const FAILED_WORKER_STATUSES: ReadonlySet<MissionWorker["status"]> = new Set([
  "blocked",
  "failed",
  "cancelled",
]);

export function normalizeWorkerScope(scope: string) {
  return scope
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

export function workerScopesOverlap(first: string, second: string) {
  const left = normalizeWorkerScope(first);
  const right = normalizeWorkerScope(second);
  if (!left || !right) {
    return false;
  }
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

export function detectWorkerScopeConflicts(
  workers: Pick<MissionWorker, "workerKey" | "fileScopes">[],
): WorkerConflict[] {
  const conflicts: WorkerConflict[] = [];

  for (let i = 0; i < workers.length; i += 1) {
    for (let j = i + 1; j < workers.length; j += 1) {
      const first = workers[i];
      const second = workers[j];
      const overlappingScopes = (first.fileScopes ?? []).filter((firstScope) =>
        (second.fileScopes ?? []).some((secondScope) =>
          workerScopesOverlap(firstScope, secondScope),
        ),
      );

      if (overlappingScopes.length > 0) {
        conflicts.push({
          firstWorkerKey: first.workerKey,
          secondWorkerKey: second.workerKey,
          overlappingScopes,
        });
      }
    }
  }

  return conflicts;
}

export function getWorkerDependencyBlocks(
  workers: Pick<MissionWorker, "workerKey" | "status" | "dependsOn">[],
): WorkerDependencyBlock[] {
  const workersByKey = new Map(
    workers.map((worker) => [worker.workerKey, worker]),
  );

  return workers
    .map((worker) => {
      const missingDependencies: string[] = [];
      const incompleteDependencies: string[] = [];

      for (const dependencyKey of worker.dependsOn ?? []) {
        const dependency = workersByKey.get(dependencyKey);
        if (!dependency) {
          missingDependencies.push(dependencyKey);
        } else if (dependency.status !== "completed") {
          incompleteDependencies.push(dependencyKey);
        }
      }

      return {
        workerKey: worker.workerKey,
        missingDependencies,
        incompleteDependencies,
      };
    })
    .filter(
      (block) =>
        block.missingDependencies.length > 0 ||
        block.incompleteDependencies.length > 0,
    );
}

export function selectDispatchableWorkers<
  T extends Pick<MissionWorker, "workerKey" | "status" | "dependsOn">,
>(workers: T[]): T[] {
  const blockedWorkerKeys = new Set(
    getWorkerDependencyBlocks(workers).map((block) => block.workerKey),
  );

  return workers.filter(
    (worker) =>
      (worker.status === "queued" || worker.status === "ready") &&
      !blockedWorkerKeys.has(worker.workerKey),
  );
}

export function detectStaleRunningWorkers(
  workers: Pick<MissionWorker, "workerKey" | "status" | "updatedAt">[],
  now: Date,
  staleAfterMs: number,
): StaleWorker[] {
  return workers
    .filter((worker) => worker.status === "running")
    .map((worker) => ({
      workerKey: worker.workerKey,
      staleForMs: now.getTime() - worker.updatedAt.getTime(),
    }))
    .filter((worker) => worker.staleForMs >= staleAfterMs);
}

export function areWorkerOutputsReadyForIntegration(
  workers: Pick<MissionWorker, "role" | "status">[],
) {
  const workerOutputs = workers.filter(
    (worker) => worker.role !== "planner" && worker.role !== "integrator",
  );

  return (
    workerOutputs.length > 0 &&
    workerOutputs.every((worker) => worker.status === "completed") &&
    workers.every((worker) => !FAILED_WORKER_STATUSES.has(worker.status))
  );
}

export function detectWorkerOutputConflicts(
  workers: Pick<MissionWorker, "workerKey" | "metadata">[],
): WorkerOutputConflict[] {
  const reportedWorkers = workers
    .map((worker) => ({
      worker,
      report: getWorkerReport(worker.metadata),
    }))
    .filter(
      (
        entry,
      ): entry is {
        worker: Pick<MissionWorker, "workerKey" | "metadata">;
        report: NormalizedMissionWorkerReport;
      } => entry.report !== null,
    );
  const conflicts: WorkerOutputConflict[] = [];

  for (let i = 0; i < reportedWorkers.length; i += 1) {
    for (let j = i + 1; j < reportedWorkers.length; j += 1) {
      const first = reportedWorkers[i];
      const second = reportedWorkers[j];
      const overlappingFiles = first.report.changedFiles.filter((firstFile) =>
        second.report.changedFiles.some((secondFile) =>
          workerScopesOverlap(firstFile, secondFile),
        ),
      );

      if (overlappingFiles.length > 0) {
        conflicts.push({
          firstWorkerKey: first.worker.workerKey,
          secondWorkerKey: second.worker.workerKey,
          overlappingFiles,
        });
      }
    }
  }

  return conflicts;
}

export function getWorkerIntegrationStatus(
  metadata: Record<string, unknown> | null | undefined,
): WorkerIntegrationStatus {
  const status = metadata?.integrationStatus;
  if (status === "applied" || status === "rejected") {
    return status;
  }
  return "pending";
}

export function buildWorkerIntegrationPlan(
  workers: Pick<MissionWorker, "workerKey" | "role" | "status" | "metadata">[],
): WorkerIntegrationPlan {
  const reportableWorkers = workers.filter(
    (worker) => worker.role !== "planner" && worker.role !== "integrator",
  );
  const completedWorkers = reportableWorkers.filter(
    (worker) =>
      worker.status === "completed" && getWorkerReport(worker.metadata),
  );
  const pendingWorkerKeys = completedWorkers
    .filter(
      (worker) => getWorkerIntegrationStatus(worker.metadata) === "pending",
    )
    .map((worker) => worker.workerKey);
  const appliedWorkerKeys = completedWorkers
    .filter(
      (worker) => getWorkerIntegrationStatus(worker.metadata) === "applied",
    )
    .map((worker) => worker.workerKey);
  const rejectedWorkerKeys = completedWorkers
    .filter(
      (worker) => getWorkerIntegrationStatus(worker.metadata) === "rejected",
    )
    .map((worker) => worker.workerKey);
  const conflicts = detectWorkerOutputConflicts(completedWorkers);

  return {
    isReady:
      completedWorkers.length > 0 &&
      pendingWorkerKeys.length === 0 &&
      conflicts.length === 0 &&
      rejectedWorkerKeys.length === 0,
    pendingWorkerKeys,
    appliedWorkerKeys,
    rejectedWorkerKeys,
    conflicts,
  };
}

export function buildWorkerIntegrationMetadata(input: {
  existing: WorkerLifecycleMetadata;
  status: WorkerIntegrationStatus;
  reason?: string | null;
  now: Date;
}) {
  return mergeWorkerMetadata(input.existing, {
    integrationStatus: input.status,
    integrationReason: input.reason ?? null,
    integrationUpdatedAt: input.now.toISOString(),
  });
}

export function normalizeMissionWorkerReport(
  report: MissionWorkerReportInput,
): NormalizedMissionWorkerReport {
  return {
    summary: report.summary.trim(),
    changedFiles: uniqueTrimmed(report.changedFiles ?? []),
    validation: normalizeOptionalText(report.validation),
    blockers: normalizeOptionalText(report.blockers),
    artifacts: uniqueTrimmed(report.artifacts ?? []),
  };
}

export function mergeWorkerMetadata(
  existing: WorkerLifecycleMetadata,
  update: Record<string, unknown>,
) {
  return {
    ...(existing ?? {}),
    ...update,
  };
}

export function buildWorkerLifecycleMetadata(input: {
  existing: WorkerLifecycleMetadata;
  status: MissionWorker["status"];
  reason?: string | null;
  now: Date;
}) {
  const stale =
    input.status === "running"
      ? false
      : input.status === "queued" || input.status === "ready"
        ? false
        : getMetadataBoolean(input.existing, "stale");
  return mergeWorkerMetadata(input.existing, {
    stale,
    lastLifecycleAt: input.now.toISOString(),
    lastLifecycleStatus: input.status,
    lastLifecycleReason: input.reason ?? null,
  });
}

export function buildWorkerStaleMetadata(input: {
  existing: WorkerLifecycleMetadata;
  staleForMs: number;
  now: Date;
}) {
  return mergeWorkerMetadata(input.existing, {
    stale: true,
    staleForMs: input.staleForMs,
    staleDetectedAt: input.now.toISOString(),
    lastLifecycleAt: input.now.toISOString(),
    lastLifecycleStatus: "running_stale",
  });
}

export function getWorkerReport(
  metadata: Record<string, unknown> | null | undefined,
) {
  const report = metadata?.report;
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return null;
  }
  const value = report as Record<string, unknown>;
  const summary = value.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return null;
  }
  return normalizeMissionWorkerReport({
    summary,
    changedFiles: getStringArray(value.changedFiles),
    validation: typeof value.validation === "string" ? value.validation : null,
    blockers: typeof value.blockers === "string" ? value.blockers : null,
    artifacts: getStringArray(value.artifacts),
  });
}

export function workerHasStaleMetadata(
  worker: Pick<MissionWorker, "metadata">,
) {
  return getMetadataBoolean(worker.metadata, "stale");
}

export function buildWorkerSeedFromTasks(
  tasks: Pick<MissionTask, "externalId" | "title" | "status">[],
) {
  const activeTasks = tasks.filter((task) => task.status !== "completed");
  return [
    {
      workerKey: "planner",
      role: "planner" as const,
      title: "Plan worker packages",
      goal: "Turn the mission goal and active tasks into disjoint implementation packages.",
      fileScopes: ["plans", "docs"],
      dependsOn: null,
    },
    ...activeTasks.map((task, index) => ({
      workerKey: `builder-${task.externalId}`,
      role: "builder" as const,
      title: task.title,
      goal: `Implement mission task: ${task.title}`,
      fileScopes: [`task-scopes/${task.externalId}`],
      dependsOn: index === 0 ? ["planner"] : ["planner"],
    })),
    {
      workerKey: "qa",
      role: "qa" as const,
      title: "Verify integrated mission output",
      goal: "Run checks, inspect artifacts, and report regressions before integration.",
      fileScopes: ["tests", "e2e-tests"],
      dependsOn: [
        "planner",
        ...activeTasks.map((task) => `builder-${task.externalId}`),
      ],
    },
    {
      workerKey: "integrator",
      role: "integrator" as const,
      title: "Integrate worker outputs",
      goal: "Review worker outputs, resolve conflicts, and prepare the final mission result.",
      fileScopes: ["."],
      dependsOn: [
        "qa",
        ...activeTasks.map((task) => `builder-${task.externalId}`),
      ],
    },
  ];
}

function normalizeOptionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function uniqueTrimmed(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function getStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function getMetadataBoolean(
  metadata: WorkerLifecycleMetadata | undefined,
  key: string,
) {
  return metadata?.[key] === true;
}
