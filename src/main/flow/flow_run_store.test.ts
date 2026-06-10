import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";

let userDataDir = "";
vi.mock("@/paths/paths", () => ({
  getUserDataPath: () => userDataDir,
}));

import {
  saveFlowRun,
  saveFlowRunSafe,
  loadFlowRun,
  deleteFlowRun,
  listResumableFlowRuns,
  type PersistedFlowRun,
} from "./flow_run_store";
import type { CommandIntent } from "@/ipc/types/intent";

const intent: CommandIntent = {
  goal: "test goal",
  steps: [
    { id: "img", capability: "generate_image", input: { prompt: "x" } },
    { id: "vid", capability: "generate_video", input: { prompt: "y" } },
  ],
};

function makeRun(overrides: Partial<PersistedFlowRun>): PersistedFlowRun {
  return {
    flowId: crypto.randomUUID(),
    intent,
    status: "running",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    steps: [],
    ...overrides,
  };
}

beforeAll(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-store-"));
});

describe("flow_run_store", () => {
  it("round-trips a run", async () => {
    const run = makeRun({
      steps: [
        {
          stepId: "img",
          capability: "generate_image",
          status: "success",
          output: { outputPath: "/tmp/a.png" },
          durationMs: 5,
        },
      ],
    });
    await saveFlowRun(run);
    const loaded = await loadFlowRun(run.flowId);
    expect(loaded).toEqual(run);
  });

  it("returns null for a missing run and never throws on safe save", async () => {
    expect(await loadFlowRun("does-not-exist")).toBeNull();
    await expect(
      saveFlowRunSafe(makeRun({ flowId: "ok" })),
    ).resolves.toBeUndefined();
  });

  it("lists non-completed runs newest first with progress counts", async () => {
    const older = makeRun({ status: "failed", updatedAt: Date.now() - 5000 });
    const newer = makeRun({
      status: "running",
      updatedAt: Date.now(),
      steps: [
        {
          stepId: "img",
          capability: "generate_image",
          status: "success",
          output: {},
          durationMs: 1,
        },
      ],
    });
    const done = makeRun({ status: "completed" });
    await Promise.all([
      saveFlowRun(older),
      saveFlowRun(newer),
      saveFlowRun(done),
    ]);

    const list = await listResumableFlowRuns();
    const ids = list.map((s) => s.flowId);
    expect(ids).toContain(older.flowId);
    expect(ids).toContain(newer.flowId);
    expect(ids).not.toContain(done.flowId);
    expect(ids.indexOf(newer.flowId)).toBeLessThan(ids.indexOf(older.flowId));

    const newerSummary = list.find((s) => s.flowId === newer.flowId)!;
    expect(newerSummary.totalSteps).toBe(2);
    expect(newerSummary.completedSteps).toBe(1);
    expect(newerSummary.goal).toBe("test goal");
  });

  it("prunes expired runs from the listing", async () => {
    const ancient = makeRun({
      status: "failed",
      updatedAt: Date.now() - 15 * 24 * 60 * 60 * 1000,
    });
    await saveFlowRun(ancient);
    const list = await listResumableFlowRuns();
    expect(list.map((s) => s.flowId)).not.toContain(ancient.flowId);
    expect(await loadFlowRun(ancient.flowId)).toBeNull();
  });

  it("deletes a run", async () => {
    const run = makeRun({});
    await saveFlowRun(run);
    await deleteFlowRun(run.flowId);
    expect(await loadFlowRun(run.flowId)).toBeNull();
  });
});
