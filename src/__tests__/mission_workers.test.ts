import { describe, expect, it } from "vitest";

import {
  areWorkerOutputsReadyForIntegration,
  buildWorkerIntegrationMetadata,
  buildWorkerIntegrationPlan,
  buildWorkerLifecycleMetadata,
  buildWorkerStaleMetadata,
  buildWorkerSeedFromTasks,
  detectStaleRunningWorkers,
  detectWorkerOutputConflicts,
  detectWorkerScopeConflicts,
  getWorkerIntegrationStatus,
  getWorkerReport,
  getWorkerDependencyBlocks,
  normalizeMissionWorkerReport,
  selectDispatchableWorkers,
  workerHasStaleMetadata,
  workerScopesOverlap,
} from "@/ipc/utils/mission_workers";

describe("mission workers", () => {
  it("detects overlapping worker file scopes", () => {
    expect(
      workerScopesOverlap("src/components", "src/components/App.tsx"),
    ).toBe(true);
    expect(workerScopesOverlap("src/components", "src/server")).toBe(false);

    expect(
      detectWorkerScopeConflicts([
        {
          workerKey: "builder-ui",
          fileScopes: ["src/components"],
        },
        {
          workerKey: "builder-app",
          fileScopes: ["src/components/App.tsx"],
        },
      ]),
    ).toEqual([
      {
        firstWorkerKey: "builder-ui",
        secondWorkerKey: "builder-app",
        overlappingScopes: ["src/components"],
      },
    ]);
  });

  it("builds worker seed packages from active mission tasks", () => {
    expect(
      buildWorkerSeedFromTasks([
        { externalId: "done", title: "Done", status: "completed" },
        { externalId: "ui", title: "Build UI", status: "pending" },
      ]),
    ).toMatchObject([
      { workerKey: "planner", role: "planner" },
      {
        workerKey: "builder-ui",
        role: "builder",
        title: "Build UI",
        dependsOn: ["planner"],
      },
      { workerKey: "qa", role: "qa", dependsOn: ["planner", "builder-ui"] },
      {
        workerKey: "integrator",
        role: "integrator",
        dependsOn: ["qa", "builder-ui"],
      },
    ]);
  });

  it("selects queued workers whose dependencies are complete", () => {
    const workers = [
      {
        workerKey: "planner",
        status: "completed" as const,
        dependsOn: null,
      },
      {
        workerKey: "builder-ui",
        status: "queued" as const,
        dependsOn: ["planner"],
      },
      {
        workerKey: "builder-api",
        status: "queued" as const,
        dependsOn: ["planner"],
      },
      {
        workerKey: "qa",
        status: "queued" as const,
        dependsOn: ["builder-ui", "builder-api"],
      },
      {
        workerKey: "integrator",
        status: "queued" as const,
        dependsOn: ["qa"],
      },
    ];

    expect(
      selectDispatchableWorkers(workers).map((worker) => worker.workerKey),
    ).toEqual(["builder-ui", "builder-api"]);
  });

  it("also selects ready workers with satisfied dependencies", () => {
    const workers = [
      {
        workerKey: "planner",
        status: "completed" as const,
        dependsOn: null,
      },
      {
        workerKey: "builder-ui",
        status: "ready" as const,
        dependsOn: ["planner"],
      },
    ];

    expect(
      selectDispatchableWorkers(workers).map((worker) => worker.workerKey),
    ).toEqual(["builder-ui"]);
  });

  it("reports missing and incomplete worker dependencies", () => {
    expect(
      getWorkerDependencyBlocks([
        {
          workerKey: "planner",
          status: "running",
          dependsOn: null,
        },
        {
          workerKey: "builder-ui",
          status: "queued",
          dependsOn: ["planner", "architect"],
        },
      ]),
    ).toEqual([
      {
        workerKey: "builder-ui",
        missingDependencies: ["architect"],
        incompleteDependencies: ["planner"],
      },
    ]);
  });

  it("detects stale running workers", () => {
    expect(
      detectStaleRunningWorkers(
        [
          {
            workerKey: "builder-ui",
            status: "running",
            updatedAt: new Date("2026-05-05T00:00:00.000Z"),
          },
          {
            workerKey: "builder-api",
            status: "running",
            updatedAt: new Date("2026-05-05T00:04:30.000Z"),
          },
          {
            workerKey: "qa",
            status: "queued",
            updatedAt: new Date("2026-05-05T00:00:00.000Z"),
          },
        ],
        new Date("2026-05-05T00:05:00.000Z"),
        5 * 60 * 1000,
      ),
    ).toEqual([{ workerKey: "builder-ui", staleForMs: 5 * 60 * 1000 }]);
  });

  it("checks whether worker outputs are ready for integration", () => {
    expect(
      areWorkerOutputsReadyForIntegration([
        { role: "planner", status: "completed" },
        { role: "builder", status: "completed" },
        { role: "qa", status: "completed" },
        { role: "integrator", status: "queued" },
      ]),
    ).toBe(true);

    expect(
      areWorkerOutputsReadyForIntegration([
        { role: "planner", status: "completed" },
        { role: "builder", status: "running" },
        { role: "qa", status: "queued" },
        { role: "integrator", status: "queued" },
      ]),
    ).toBe(false);

    expect(
      areWorkerOutputsReadyForIntegration([
        { role: "planner", status: "completed" },
        { role: "builder", status: "failed" },
        { role: "qa", status: "completed" },
        { role: "integrator", status: "queued" },
      ]),
    ).toBe(false);
  });

  it("normalizes worker completion reports", () => {
    expect(
      normalizeMissionWorkerReport({
        summary: "  Built UI  ",
        changedFiles: [" src/App.tsx ", "src/App.tsx", ""],
        validation: " npm test ",
        blockers: " ",
        artifacts: [" screenshot.png "],
      }),
    ).toEqual({
      summary: "Built UI",
      changedFiles: ["src/App.tsx"],
      validation: "npm test",
      blockers: null,
      artifacts: ["screenshot.png"],
    });
  });

  it("tracks lifecycle and stale metadata", () => {
    const runningMetadata = buildWorkerLifecycleMetadata({
      existing: { stale: true },
      status: "running",
      now: new Date("2026-05-05T00:00:00.000Z"),
      reason: "dependencies_satisfied",
    });
    expect(runningMetadata).toMatchObject({
      stale: false,
      lastLifecycleStatus: "running",
      lastLifecycleReason: "dependencies_satisfied",
    });

    const staleMetadata = buildWorkerStaleMetadata({
      existing: runningMetadata,
      staleForMs: 900000,
      now: new Date("2026-05-05T00:15:00.000Z"),
    });
    expect(workerHasStaleMetadata({ metadata: staleMetadata })).toBe(true);
    expect(staleMetadata).toMatchObject({
      stale: true,
      staleForMs: 900000,
      lastLifecycleStatus: "running_stale",
    });
  });

  it("reads worker reports from metadata", () => {
    expect(
      getWorkerReport({
        report: {
          summary: "Implemented worker output",
          changedFiles: ["src/a.ts"],
          validation: "npm test",
          blockers: null,
          artifacts: ["artifact.txt"],
        },
      }),
    ).toEqual({
      summary: "Implemented worker output",
      changedFiles: ["src/a.ts"],
      validation: "npm test",
      blockers: null,
      artifacts: ["artifact.txt"],
    });

    expect(getWorkerReport({ report: { changedFiles: [] } })).toBeNull();
  });

  it("detects worker output conflicts from reported changed files", () => {
    expect(
      detectWorkerOutputConflicts([
        {
          workerKey: "builder-ui",
          metadata: {
            report: {
              summary: "Built UI",
              changedFiles: ["src/components"],
            },
          },
        },
        {
          workerKey: "builder-app",
          metadata: {
            report: {
              summary: "Changed app shell",
              changedFiles: ["src/components/App.tsx"],
            },
          },
        },
      ]),
    ).toEqual([
      {
        firstWorkerKey: "builder-ui",
        secondWorkerKey: "builder-app",
        overlappingFiles: ["src/components"],
      },
    ]);
  });

  it("builds an integration plan from worker reports and decisions", () => {
    const pendingMetadata = {
      report: {
        summary: "Built UI",
        changedFiles: ["src/App.tsx"],
      },
    };
    const appliedMetadata = buildWorkerIntegrationMetadata({
      existing: {
        report: {
          summary: "Verified UI",
          changedFiles: ["src/App.test.tsx"],
        },
      },
      status: "applied",
      reason: "accepted",
      now: new Date("2026-05-05T00:00:00.000Z"),
    });

    expect(getWorkerIntegrationStatus(pendingMetadata)).toBe("pending");
    expect(getWorkerIntegrationStatus(appliedMetadata)).toBe("applied");
    expect(
      buildWorkerIntegrationPlan([
        {
          workerKey: "builder-ui",
          role: "builder",
          status: "completed",
          metadata: pendingMetadata,
        },
        {
          workerKey: "qa",
          role: "qa",
          status: "completed",
          metadata: appliedMetadata,
        },
      ]),
    ).toMatchObject({
      isReady: false,
      pendingWorkerKeys: ["builder-ui"],
      appliedWorkerKeys: ["qa"],
      rejectedWorkerKeys: [],
      conflicts: [],
    });
  });
});
