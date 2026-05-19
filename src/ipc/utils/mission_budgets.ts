/**
 * Default wall-clock cap on a single mission turn. Raised from 45min → 8h
 * after users running local llama-server complained that complex builds
 * (Electron, Android packaging) routinely hit the old cap mid-iteration.
 * The cap remains overridable per call via runtimeBudgetMs and via the
 * `missionRuntimeBudgetMinutes` user setting (clamped [10, 1440]).
 */
export const MISSION_RUNTIME_BUDGET_MS = 8 * 60 * 60 * 1000;

/** Inclusive bounds for the user-overridable mission runtime budget. */
export const MIN_MISSION_RUNTIME_BUDGET_MINUTES = 10;
export const MAX_MISSION_RUNTIME_BUDGET_MINUTES = 24 * 60;

export function clampMissionRuntimeBudgetMs(
  budgetMinutes: number | null | undefined,
): number {
  if (typeof budgetMinutes !== "number" || !Number.isFinite(budgetMinutes)) {
    return MISSION_RUNTIME_BUDGET_MS;
  }
  const clamped = Math.min(
    MAX_MISSION_RUNTIME_BUDGET_MINUTES,
    Math.max(MIN_MISSION_RUNTIME_BUDGET_MINUTES, Math.floor(budgetMinutes)),
  );
  return clamped * 60 * 1000;
}
export const MISSION_CONSECUTIVE_TOOL_FAILURE_LIMIT = 3;
export const MISSION_TOTAL_TOOL_FAILURE_LIMIT = 8;
export const MISSION_REPEATED_STEP_LOOP_LIMIT = 3;
export const MISSION_MAX_WORKER_SEED_TASKS = 8;
export const MISSION_MAX_WORKER_REPORT_ITEMS = 50;
export const MISSION_WORKER_REPORT_TEXT_LIMIT_CHARS = 2000;

export type ToolFailureBudgetState = {
  totalFailures: number;
  consecutiveFailuresByTool: Record<string, number>;
};

export type ToolFailureBudgetDecision =
  | {
      exceeded: false;
      state: ToolFailureBudgetState;
    }
  | {
      exceeded: true;
      state: ToolFailureBudgetState;
      budgetType: "total_tool_failures" | "consecutive_tool_failures";
      reason: string;
      toolName: string;
      count: number;
      limit: number;
    };

export function createToolFailureBudgetState(): ToolFailureBudgetState {
  return {
    totalFailures: 0,
    consecutiveFailuresByTool: {},
  };
}

export function recordToolFailureForBudget(input: {
  state: ToolFailureBudgetState;
  toolName: string;
  consecutiveFailureLimit?: number;
  totalFailureLimit?: number;
}): ToolFailureBudgetDecision {
  const consecutiveFailureLimit =
    input.consecutiveFailureLimit ?? MISSION_CONSECUTIVE_TOOL_FAILURE_LIMIT;
  const totalFailureLimit =
    input.totalFailureLimit ?? MISSION_TOTAL_TOOL_FAILURE_LIMIT;
  const nextConsecutive =
    (input.state.consecutiveFailuresByTool[input.toolName] ?? 0) + 1;
  const state: ToolFailureBudgetState = {
    totalFailures: input.state.totalFailures + 1,
    consecutiveFailuresByTool: {
      ...input.state.consecutiveFailuresByTool,
      [input.toolName]: nextConsecutive,
    },
  };

  if (nextConsecutive >= consecutiveFailureLimit) {
    return {
      exceeded: true,
      state,
      budgetType: "consecutive_tool_failures",
      reason: `${input.toolName} failed ${nextConsecutive} times in a row.`,
      toolName: input.toolName,
      count: nextConsecutive,
      limit: consecutiveFailureLimit,
    };
  }

  if (state.totalFailures >= totalFailureLimit) {
    return {
      exceeded: true,
      state,
      budgetType: "total_tool_failures",
      reason: `Mission reached ${state.totalFailures} failed tool executions.`,
      toolName: input.toolName,
      count: state.totalFailures,
      limit: totalFailureLimit,
    };
  }

  return { exceeded: false, state };
}

export function recordToolSuccessForBudget(input: {
  state: ToolFailureBudgetState;
  toolName: string;
}): ToolFailureBudgetState {
  if (!input.state.consecutiveFailuresByTool[input.toolName]) {
    return input.state;
  }
  return {
    ...input.state,
    consecutiveFailuresByTool: {
      ...input.state.consecutiveFailuresByTool,
      [input.toolName]: 0,
    },
  };
}

export function getMissionRuntimeBudgetStatus(input: {
  startedAtMs: number;
  nowMs: number;
  runtimeBudgetMs?: number;
}) {
  const limit = input.runtimeBudgetMs ?? MISSION_RUNTIME_BUDGET_MS;
  const elapsedMs = input.nowMs - input.startedAtMs;
  return {
    exceeded: elapsedMs >= limit,
    elapsedMs,
    limit,
  };
}

export function truncateWorkerSeedTasks<T>(
  tasks: readonly T[],
  limit = MISSION_MAX_WORKER_SEED_TASKS,
) {
  return {
    selectedTasks: tasks.slice(0, limit),
    omittedTaskCount: Math.max(0, tasks.length - limit),
  };
}

export function truncateMissionWorkerReportItems(
  values: readonly string[],
  limit = MISSION_MAX_WORKER_REPORT_ITEMS,
) {
  const selected = values.slice(0, limit);
  if (values.length > limit) {
    selected.push(`[${values.length - limit} items omitted]`);
  }
  return selected;
}

export function truncateMissionWorkerReportText(
  value: string | null | undefined,
  limit = MISSION_WORKER_REPORT_TEXT_LIMIT_CHARS,
) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}...[truncated ${trimmed.length - limit} chars]`;
}
