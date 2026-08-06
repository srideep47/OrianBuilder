import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MartaTask } from "@/ipc/types/marta";

const callHandler = vi.fn();
const control = vi.fn();
const getMartaTask = vi.fn();
const updateMartaTask = vi.fn();

vi.mock("./invoke_action", () => ({
  callHandler: (...args: unknown[]) => callHandler(...args),
}));
vi.mock("./parallel_executive_service", () => ({
  getParallelExecutive: () => ({ control }),
}));
vi.mock("./task_registry", () => ({
  getMartaTask: (...args: unknown[]) => getMartaTask(...args),
  updateMartaTask: (...args: unknown[]) => updateMartaTask(...args),
}));

const { controlMartaTask } = await import("./task_control");

function task(over: Partial<MartaTask> = {}): MartaTask {
  return {
    id: "claude:turn-1",
    runtimeId: "turn-1",
    kind: "claude",
    title: "Website build",
    goal: "Build the site",
    workerLabel: "Claude Code",
    status: "running",
    completedSteps: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  callHandler.mockResolvedValue({ ok: true, data: {} });
  control.mockResolvedValue({});
});

describe("stop", () => {
  it("cancels a Claude turn through its own runtime", async () => {
    getMartaTask.mockReturnValue(task());

    const result = await controlMartaTask({
      taskId: "claude:turn-1",
      action: "stop",
    });

    expect(result.ok).toBe(true);
    expect(callHandler).toHaveBeenCalledWith(
      "claude-code:cancel-turn",
      { turnId: "turn-1" },
      expect.anything(),
    );
    expect(updateMartaTask).toHaveBeenCalledWith(
      "claude:turn-1",
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("cancels a local worker through the mission database", async () => {
    getMartaTask.mockReturnValue(
      task({ id: "mission:100", runtimeId: "100", kind: "local" }),
    );

    await controlMartaTask({ taskId: "mission:100", action: "stop" });

    expect(callHandler).toHaveBeenCalledWith(
      "mission:update-status",
      { missionId: 100, status: "cancelled" },
      expect.anything(),
    );
  });

  it("cancels a graph node through the scheduler, not the worker", async () => {
    // Reaching past the graph would leave its joins waiting forever.
    getMartaTask.mockReturnValue(
      task({ id: "goal:g1:n2", goalId: "g1", workstreamId: "n2" }),
    );

    await controlMartaTask({ taskId: "goal:g1:n2", action: "stop" });

    expect(control).toHaveBeenCalledWith("g1", {
      action: "cancel-node",
      nodeId: "n2",
    });
    expect(callHandler).not.toHaveBeenCalled();
  });

  it("does not report a stop when the runtime refused", async () => {
    getMartaTask.mockReturnValue(task());
    callHandler.mockResolvedValue({ ok: false, error: "no such turn" });

    const result = await controlMartaTask({
      taskId: "claude:turn-1",
      action: "stop",
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("no such turn");
    // The critical part: the ledger is not marked cancelled on a failed stop.
    expect(updateMartaTask).not.toHaveBeenCalled();
  });

  it("is a no-op on work that already finished", async () => {
    getMartaTask.mockReturnValue(task({ status: "succeeded" }));

    const result = await controlMartaTask({
      taskId: "claude:turn-1",
      action: "stop",
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("already");
    expect(callHandler).not.toHaveBeenCalled();
  });

  it("explains itself for a task with no live runtime", async () => {
    getMartaTask.mockReturnValue(task({ runtimeId: undefined }));

    const result = await controlMartaTask({
      taskId: "claude:turn-1",
      action: "stop",
    });

    expect(result.ok).toBe(false);
    expect(callHandler).not.toHaveBeenCalled();
  });

  it("says so when the task is gone", async () => {
    getMartaTask.mockReturnValue(undefined);
    const result = await controlMartaTask({ taskId: "gone", action: "stop" });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("no longer in the ledger");
  });
});

describe("retry", () => {
  it("refuses to retry work that is still running", async () => {
    getMartaTask.mockReturnValue(task({ status: "running" }));
    const result = await controlMartaTask({
      taskId: "claude:turn-1",
      action: "retry",
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("still running");
  });

  it("retries only the failed workers of a mission", async () => {
    // Re-running a completed worker would redo accepted work, and could undo it.
    getMartaTask.mockReturnValue(
      task({
        id: "mission:100",
        runtimeId: "100",
        kind: "local",
        status: "failed",
      }),
    );
    callHandler.mockImplementation(async (channel: string) => {
      if (channel === "mission:list-workers") {
        return {
          ok: true,
          data: [
            { id: 1, status: "completed" },
            { id: 2, status: "failed" },
          ],
        };
      }
      return { ok: true, data: {} };
    });

    const result = await controlMartaTask({
      taskId: "mission:100",
      action: "retry",
    });

    expect(result.ok).toBe(true);
    const retries = callHandler.mock.calls.filter(
      ([channel]) => channel === "mission:retry-worker",
    );
    expect(retries).toHaveLength(1);
    expect(retries[0][1]).toEqual({ workerId: 2 });
  });

  it("tells the truth that a finished Claude turn cannot be resumed", async () => {
    getMartaTask.mockReturnValue(task({ status: "failed" }));
    const result = await controlMartaTask({
      taskId: "claude:turn-1",
      action: "retry",
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("starts fresh");
  });
});

describe("prioritize", () => {
  it("reorders a graph node through the scheduler", async () => {
    getMartaTask.mockReturnValue(
      task({ id: "goal:g1:n2", goalId: "g1", workstreamId: "n2" }),
    );

    const result = await controlMartaTask({
      taskId: "goal:g1:n2",
      action: "prioritize",
      priority: 100,
    });

    expect(result.ok).toBe(true);
    expect(control).toHaveBeenCalledWith("g1", {
      action: "prioritize",
      nodeId: "n2",
      priority: 100,
    });
  });

  it("admits that priority means nothing for an unscheduled task", async () => {
    getMartaTask.mockReturnValue(task());

    const result = await controlMartaTask({
      taskId: "claude:turn-1",
      action: "prioritize",
      priority: 100,
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("not part of a scheduled goal");
    expect(control).not.toHaveBeenCalled();
  });
});
