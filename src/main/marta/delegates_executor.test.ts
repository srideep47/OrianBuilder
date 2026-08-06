/**
 * Delegation-time acceptance parity.
 *
 * The bug these tests exist for: `runLocalCodeTask` created the ledger entry but
 * never captured a pre-task baseline, so when the mission reported success
 * `verifyMartaTaskAcceptance` correctly refused to certify it — and *every*
 * local delegation ended as "Acceptance verification unavailable" no matter how
 * well the worker did. One contract per coding worker, not one per vendor.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const callHandler = vi.fn();
const invokeAction = vi.fn();
const updateMartaTask = vi.fn();
const createMartaTask = vi.fn();
const prepareCodingTaskAcceptance = vi.fn();
const resolveCodingTaskProjectRoot = vi.fn();
const getMartaPreferences = vi.fn();

vi.mock("./invoke_action", () => ({
  callHandler: (...args: unknown[]) => callHandler(...args),
  invokeAction: (...args: unknown[]) => invokeAction(...args),
  summariseResult: (value: unknown) => JSON.stringify(value),
}));

vi.mock("./task_registry", () => ({
  createMartaTask: (...args: unknown[]) => createMartaTask(...args),
  updateMartaTask: (...args: unknown[]) => updateMartaTask(...args),
  broadcastMartaDelegationChoice: vi.fn(),
}));

vi.mock("./task_acceptance_verifier", () => ({
  prepareCodingTaskAcceptance: (...args: unknown[]) =>
    prepareCodingTaskAcceptance(...args),
  resolveCodingTaskProjectRoot: (...args: unknown[]) =>
    resolveCodingTaskProjectRoot(...args),
}));

vi.mock("./marta_memory_store", () => ({
  getMartaPreferences: () => getMartaPreferences(),
  rememberDelegationSelection: vi.fn(async () => {}),
}));

vi.mock("./big_brain", () => ({ askBigBrain: vi.fn() }));
vi.mock("@/pro/main/ipc/handlers/local_agent/tools/web_search", () => ({
  performResearch: vi.fn(),
}));

const { executeDelegate } = await import("./delegates_executor");

const TARGET = {
  goal: "Make the homepage heading say Welcome",
  projectRoot: "C:/workspace/site",
  targetPaths: ["src"],
  readOnly: false,
  requireChangedFiles: true,
  requiredChecks: ["build", "preview", "visual"],
};
const BASELINE = { capturedAt: 1, files: {} };

function localDelegate(goal = TARGET.goal) {
  return executeDelegate({
    delegateId: "delegate.code",
    args: { appId: 12, goal },
    userText: "use local qwen 4b",
  });
}

/** The goal string the mission worker was actually created with. */
function workerGoal(): string {
  const call = callHandler.mock.calls.find(
    ([channel]) => channel === "mission:create-worker",
  );
  expect(call, "no mission worker was created").toBeDefined();
  return (call![1] as { goal: string }).goal;
}

beforeEach(() => {
  vi.clearAllMocks();
  getMartaPreferences.mockResolvedValue({
    codingWorker: "local",
    localModel: "lmstudio:qwen3.5-4b",
    claudeModel: null,
    claudeEffort: null,
    narrationDetail: "normal",
  });
  resolveCodingTaskProjectRoot.mockResolvedValue("C:/workspace/site");
  prepareCodingTaskAcceptance.mockResolvedValue({
    target: TARGET,
    baseline: BASELINE,
  });
  callHandler.mockImplementation(async (channel: string) => {
    if (channel === "create-chat") return { ok: true, data: 501 };
    if (channel === "mission:create") return { ok: true, data: { id: 100 } };
    return { ok: true, data: {} };
  });
});

describe("local coding delegation", () => {
  it("attaches a pre-task baseline to the ledger entry", async () => {
    const result = await localDelegate();

    expect(result.ok).toBe(true);
    expect(result.taskId).toBe("mission:100");
    expect(resolveCodingTaskProjectRoot).toHaveBeenCalledWith(12);
    expect(updateMartaTask).toHaveBeenCalledWith("mission:100", {
      acceptanceTarget: TARGET,
      acceptanceBaseline: BASELINE,
    });
  });

  it("tells the worker what evidence Orion will require", async () => {
    await localDelegate();

    const goal = workerGoal();
    expect(goal).toContain("Orion acceptance contract:");
    expect(goal).toContain("unused standalone demo file");
    expect(goal).toContain(TARGET.goal);
  });

  it("preserves the user's exact words alongside the contract", async () => {
    // The contract is appended, never a rewrite: a 4B model paraphrasing the
    // request is how "do not generate media" turns into media generation.
    await localDelegate("Do not add any images. Fix the header spacing.");
    expect(workerGoal()).toContain(
      "Do not add any images. Fix the header spacing.",
    );
  });

  it("refuses to start work it could not baseline", async () => {
    // Starting anyway would produce a task that looks healthy for ten minutes
    // and then fails at a gate it could never have passed.
    prepareCodingTaskAcceptance.mockRejectedValue(new Error("EPERM"));

    const result = await localDelegate();

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("baseline");
    expect(
      callHandler.mock.calls.some(
        ([channel]) => channel === "mission:create-worker",
      ),
    ).toBe(false);
  });

  it("marks a read-only investigation as read-only in its contract", async () => {
    await executeDelegate({
      delegateId: "delegate.code",
      args: { appId: 12, goal: "Review the routing setup", readOnly: true },
      userText: "use local qwen 4b",
    });
    expect(prepareCodingTaskAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({ readOnly: true }),
    );
  });
});

describe("Claude coding delegation", () => {
  function claudeDelegate(goal = TARGET.goal) {
    getMartaPreferences.mockResolvedValue({
      codingWorker: "claude",
      localModel: null,
      claudeModel: "haiku",
      claudeEffort: "low",
      narrationDetail: "normal",
    });
    invokeAction.mockResolvedValue({ ok: true, data: { available: true } });
    return executeDelegate({
      delegateId: "delegate.code",
      args: { appId: 12, goal },
      userText: "Claude Haiku, low effort",
    });
  }

  it("captures the baseline before the worker is dispatched", async () => {
    // Ordering is the whole contract: a snapshot taken after the first edit
    // cannot see that edit, and a crash between the two leaves a task that can
    // never be certified.
    const order: string[] = [];
    prepareCodingTaskAcceptance.mockImplementation(async () => {
      order.push("baseline");
      return { target: TARGET, baseline: BASELINE };
    });
    callHandler.mockImplementation(async (channel: string) => {
      if (channel === "claude-code:start-turn") order.push("dispatch");
      return { ok: true, data: {} };
    });

    const result = await claudeDelegate();

    expect(result.ok).toBe(true);
    expect(result.taskId).toMatch(/^claude:/);
    expect(order).toEqual(["baseline", "dispatch"]);
  });

  it("does not dispatch a turn it could not baseline", async () => {
    prepareCodingTaskAcceptance.mockRejectedValue(new Error("EPERM"));

    const result = await claudeDelegate();

    expect(result.ok).toBe(false);
    expect(
      callHandler.mock.calls.some(
        ([channel]) => channel === "claude-code:start-turn",
      ),
    ).toBe(false);
  });

  it("returns a task id the Stage can follow, with the stated effort", async () => {
    const result = await claudeDelegate();
    expect(result.taskId).toBeTruthy();
    // The effort from the first utterance has to survive onto the ledger entry;
    // the model name is normalised by the selection resolver, so it is asserted
    // loosely rather than pinned to today's alias.
    const created = createMartaTask.mock.calls.at(-1)?.[0] as {
      kind: string;
      effort?: string;
      model?: string;
    };
    expect(created.kind).toBe("claude");
    expect(created.effort).toBe("low");
    expect(created.model?.toLowerCase()).toContain("haiku");
  });
});

describe("mission delegation", () => {
  it("registers the mission in the ledger so its progress is not dropped", async () => {
    // `updateMartaTaskFromMissionEvent` returns early for an unknown task id, so
    // a mission Marta started herself used to report nothing at all.
    const result = await executeDelegate({
      delegateId: "delegate.mission",
      args: { appId: 12, title: "Ship the landing page", goal: "Ship it" },
      userText: "",
    });

    expect(result.ok).toBe(true);
    expect(result.taskId).toBe("mission:100");
    expect(createMartaTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mission:100", kind: "mission" }),
    );
  });

  it("still runs, but flags the card, when it cannot be baselined", async () => {
    prepareCodingTaskAcceptance.mockRejectedValue(new Error("ENOENT"));

    const result = await executeDelegate({
      delegateId: "delegate.mission",
      args: { appId: 12, title: "Ship it", goal: "Ship it" },
      userText: "",
    });

    expect(result.ok).toBe(true);
    expect(updateMartaTask).toHaveBeenCalledWith(
      "mission:100",
      expect.objectContaining({ requiresAttention: true }),
    );
  });
});
