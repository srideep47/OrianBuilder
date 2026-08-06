import { describe, expect, it, vi } from "vitest";

import { ParallelExecutive, type GoalNodeResult } from "./goal_graph";

describe("ParallelExecutive", () => {
  it("runs independent nodes in parallel and joins their dependent", async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const executive = new ParallelExecutive(async (node) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      order.push(node.id);
      return { ok: true, verified: true, summary: "ok" };
    });
    executive.createGoal({
      id: "g",
      title: "parallel",
      userRequest: "do both",
      maxConcurrency: 2,
      nodes: [
        { id: "a", title: "A", kind: "action", operation: "a" },
        { id: "b", title: "B", kind: "action", operation: "b" },
        {
          id: "join",
          title: "Join",
          kind: "verification",
          operation: "verify",
          dependencies: ["a", "b"],
        },
      ],
    });

    const result = await executive.runGoal("g");
    expect(peak).toBe(2);
    expect(order.slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(order[2]).toBe("join");
    expect(result.status).toBe("succeeded");
    executive.dispose();
  });

  it("serializes conflicting resources across concurrently running goals", async () => {
    const order: string[] = [];
    const executive = new ParallelExecutive(async (node) => {
      order.push(`start:${node.id}`);
      await new Promise((resolve) => setTimeout(resolve, 8));
      order.push(`end:${node.id}`);
      return { ok: true, summary: "ok" };
    });
    for (const id of ["one", "two"]) {
      executive.createGoal({
        id,
        title: id,
        userRequest: id,
        nodes: [
          {
            id,
            title: id,
            kind: "action",
            operation: id,
            resources: ["gpu:exclusive"],
          },
        ],
      });
    }
    await Promise.all([executive.runGoal("one"), executive.runGoal("two")]);
    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
    executive.dispose();
  });

  it("retries reversible transient failures but requires verification", async () => {
    const executor = vi
      .fn<() => Promise<GoalNodeResult>>()
      .mockResolvedValueOnce({
        ok: false,
        error: "provider returned 503",
        summary: "failed",
      })
      .mockResolvedValueOnce({
        ok: true,
        verified: true,
        summary: "verified",
      });
    const executive = new ParallelExecutive(executor);
    executive.createGoal({
      id: "retry",
      title: "Retry",
      userRequest: "retry safely",
      nodes: [
        {
          id: "work",
          title: "Work",
          kind: "delegate",
          operation: "delegate.code",
          maxAttempts: 2,
        },
      ],
    });
    const result = await executive.runGoal("retry");
    expect(executor).toHaveBeenCalledTimes(2);
    expect(result.nodes[0]).toMatchObject({
      status: "succeeded",
      attempt: 2,
      summary: "verified",
    });
    executive.dispose();
  });

  it("rejects cycles and cancels downstream work after failure", async () => {
    const executive = new ParallelExecutive(async () => ({
      ok: false,
      verified: false,
      summary: "acceptance failed",
      error: "verification failed",
    }));
    expect(() =>
      executive.createGoal({
        id: "cycle",
        title: "Cycle",
        userRequest: "bad",
        nodes: [
          {
            id: "a",
            title: "A",
            kind: "action",
            operation: "a",
            dependencies: ["b"],
          },
          {
            id: "b",
            title: "B",
            kind: "action",
            operation: "b",
            dependencies: ["a"],
          },
        ],
      }),
    ).toThrow("cycle");

    executive.createGoal({
      id: "failure",
      title: "Failure",
      userRequest: "fail",
      nodes: [
        {
          id: "a",
          title: "A",
          kind: "verification",
          operation: "a",
          maxAttempts: 1,
        },
        {
          id: "b",
          title: "B",
          kind: "action",
          operation: "b",
          dependencies: ["a"],
        },
      ],
    });
    const result = await executive.runGoal("failure");
    expect(result.status).toBe("failed");
    expect(result.nodes.map((node) => node.status)).toEqual([
      "failed",
      "cancelled",
    ]);
    executive.dispose();
  });

  it("cancels one running workstream without letting its late result reopen it", async () => {
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const executive = new ParallelExecutive(async () => {
      entered();
      await started;
      return { ok: true, verified: true, summary: "late success" };
    });
    executive.createGoal({
      id: "cancel-one",
      title: "Cancel one",
      userRequest: "cancel only one branch",
      nodes: [
        { id: "branch", title: "Branch", kind: "action", operation: "work" },
      ],
    });

    const completion = executive.runGoal("cancel-one");
    await running;
    executive.control("cancel-one", {
      action: "cancel-node",
      nodeId: "branch",
    });
    release();
    const result = await completion;
    expect(result.nodes[0].status).toBe("cancelled");
    expect(result.status).toBe("failed");
    executive.dispose();
  });
});
