import { describe, expect, it } from "vitest";

import {
  createToolFailureBudgetState,
  getMissionRuntimeBudgetStatus,
  recordToolFailureForBudget,
  recordToolSuccessForBudget,
  truncateMissionWorkerReportItems,
  truncateMissionWorkerReportText,
  truncateWorkerSeedTasks,
} from "@/ipc/utils/mission_budgets";

describe("mission budgets", () => {
  it("blocks repeated failures from the same tool", () => {
    let state = createToolFailureBudgetState();

    let decision = recordToolFailureForBudget({
      state,
      toolName: "run_project_check",
      consecutiveFailureLimit: 3,
    });
    expect(decision.exceeded).toBe(false);
    state = decision.state;

    decision = recordToolFailureForBudget({
      state,
      toolName: "run_project_check",
      consecutiveFailureLimit: 3,
    });
    expect(decision.exceeded).toBe(false);
    state = decision.state;

    decision = recordToolFailureForBudget({
      state,
      toolName: "run_project_check",
      consecutiveFailureLimit: 3,
    });
    expect(decision).toMatchObject({
      exceeded: true,
      budgetType: "consecutive_tool_failures",
      toolName: "run_project_check",
      count: 3,
      limit: 3,
    });
  });

  it("resets consecutive tool failures after a success", () => {
    const failed = recordToolFailureForBudget({
      state: createToolFailureBudgetState(),
      toolName: "browser_qa_gate",
    });
    const recovered = recordToolSuccessForBudget({
      state: failed.state,
      toolName: "browser_qa_gate",
    });

    expect(recovered.consecutiveFailuresByTool.browser_qa_gate).toBe(0);
  });

  it("blocks excessive total failures across tools", () => {
    let state = createToolFailureBudgetState();

    for (const toolName of ["a", "b", "c"]) {
      const decision = recordToolFailureForBudget({
        state,
        toolName,
        consecutiveFailureLimit: 99,
        totalFailureLimit: 3,
      });
      state = decision.state;
      if (toolName === "c") {
        expect(decision).toMatchObject({
          exceeded: true,
          budgetType: "total_tool_failures",
          count: 3,
          limit: 3,
        });
      }
    }
  });

  it("reports runtime budget status", () => {
    expect(
      getMissionRuntimeBudgetStatus({
        startedAtMs: 1_000,
        nowMs: 1_500,
        runtimeBudgetMs: 400,
      }),
    ).toMatchObject({
      exceeded: true,
      elapsedMs: 500,
      limit: 400,
    });
  });

  it("bounds worker seed task fan-out and worker report fields", () => {
    expect(truncateWorkerSeedTasks([1, 2, 3], 2)).toEqual({
      selectedTasks: [1, 2],
      omittedTaskCount: 1,
    });
    expect(truncateMissionWorkerReportItems(["a", "b", "c"], 2)).toEqual([
      "a",
      "b",
      "[1 items omitted]",
    ]);
    expect(truncateMissionWorkerReportText("x".repeat(10), 4)).toBe(
      "xxxx...[truncated 6 chars]",
    );
  });
});
