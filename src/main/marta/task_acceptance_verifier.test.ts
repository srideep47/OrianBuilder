import { describe, expect, it, vi } from "vitest";

import type { MartaCodingTaskFileSnapshot } from "@/ipc/types/marta";
import type { ProjectStackDetection } from "@/ipc/utils/project_stack_detector";

import { deriveCodingTaskAcceptanceTarget } from "./task_acceptance";
import {
  diffCodingProjectSnapshots,
  verifyCodingTaskAcceptance,
  type CodingTaskVerifierDependencies,
} from "./task_acceptance_verifier";
import type { VisualInspection } from "./visual_verifier";

function snapshot(
  files: Record<string, string>,
  capturedAt = 1,
): MartaCodingTaskFileSnapshot {
  return {
    capturedAt,
    files: Object.fromEntries(
      Object.entries(files).map(([file, digest]) => [
        file,
        { size: digest.length, mtimeMs: capturedAt, digest },
      ]),
    ),
  };
}

const STACK: ProjectStackDetection = {
  commands: {
    install: "npm install",
    build: "npm run build",
    typecheck: "npm run ts",
    test: null,
  },
} as unknown as ProjectStackDetection;

function inspection(over: Partial<VisualInspection> = {}): VisualInspection {
  return {
    ok: true,
    url: "http://localhost:5173",
    title: "App",
    textSample: "Rainbow Hello",
    elementCount: 300,
    screenshotPath: "C:/evidence/route.png",
    matched: [],
    pageErrors: [],
    detail: "Confirmed at the live route.",
    ...over,
  };
}

function deps(
  over: Partial<CodingTaskVerifierDependencies> = {},
): Partial<CodingTaskVerifierDependencies> {
  return {
    detectStack: vi.fn(async () => STACK),
    snapshotProject: vi.fn(async () => snapshot({ "src/App.tsx": "after" }, 2)),
    runCommand: vi.fn(async () => ({ ok: true, output: "ok" })),
    ensurePreview: vi.fn(async () => ({
      ready: true,
      previewUrl: "http://localhost:5173",
    })),
    inspectRoute: vi.fn(async () => inspection()),
    // Default: dependencies are already installed, so the install step is
    // skipped and the other tests read as before.
    fileExists: vi.fn(async () => true),
    ...over,
  };
}

/** `package.json` present, `node_modules` absent — a freshly scaffolded project. */
function freshProject() {
  return vi.fn(async (absolutePath: string) =>
    absolutePath.endsWith("package.json"),
  );
}

describe("diffCodingProjectSnapshots", () => {
  it("reports added, modified and deleted files", () => {
    expect(
      diffCodingProjectSnapshots(
        snapshot({ "a.ts": "1", "b.ts": "1" }),
        snapshot({ "a.ts": "2", "c.ts": "1" }),
      ),
    ).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("ignores a file whose content is unchanged", () => {
    // Touch-without-edit is common: a formatter or a watcher rewrites the same
    // bytes. Counting that as a change would let a no-op worker pass.
    expect(
      diffCodingProjectSnapshots(
        snapshot({ "a.ts": "same" }, 1),
        snapshot({ "a.ts": "same" }, 9_999),
      ),
    ).toEqual([]);
  });
});

describe("verifyCodingTaskAcceptance", () => {
  const uiTarget = deriveCodingTaskAcceptanceTarget({
    goal: 'Change the website heading to "Rainbow Hello"',
    projectRoot: "C:/workspace/site",
    targetPaths: ["src"],
  });

  it("accepts UI work only after the live route renders the change", async () => {
    const result = await verifyCodingTaskAcceptance(
      {
        target: uiTarget,
        baseline: snapshot({ "src/App.tsx": "before" }),
        workerReportedSuccess: true,
        appId: 7,
      },
      deps(),
    );
    expect(result.decision.accepted).toBe(true);
    expect(result.evidence.observedChangedFiles).toEqual(["src/App.tsx"]);
    expect(
      result.evidence.checks.map((check) => [check.check, check.status]),
    ).toEqual([
      ["build", "passed"],
      ["preview", "passed"],
      ["visual", "passed"],
    ]);
  });

  it("rejects the rainbow-hello case: everything green except the page", async () => {
    const result = await verifyCodingTaskAcceptance(
      {
        target: uiTarget,
        baseline: snapshot({ "src/App.tsx": "before" }),
        workerReportedSuccess: true,
        appId: 7,
      },
      deps({
        snapshotProject: vi.fn(async () =>
          snapshot({ "src/App.tsx": "before", "rainbow-hello.html": "new" }, 2),
        ),
        inspectRoute: vi.fn(async () =>
          inspection({
            ok: false,
            detail: "Not visible at the live route: “Rainbow Hello”.",
            matched: [
              { text: "Rainbow Hello", reason: "quoted", found: false },
            ],
          }),
        ),
      }),
    );
    expect(result.decision.accepted).toBe(false);
    expect(result.decision.failedChecks).toEqual(["visual"]);
  });

  it("starts the preview once and reuses its URL for the visual check", async () => {
    const ensurePreview = vi.fn(async () => ({
      ready: true,
      previewUrl: "http://localhost:5173",
    }));
    const inspectRoute = vi.fn(async () => inspection());
    await verifyCodingTaskAcceptance(
      {
        target: uiTarget,
        baseline: snapshot({ "src/App.tsx": "before" }),
        workerReportedSuccess: true,
        appId: 7,
      },
      deps({ ensurePreview, inspectRoute }),
    );
    expect(ensurePreview).toHaveBeenCalledTimes(1);
    expect(inspectRoute).toHaveBeenCalledWith({
      url: "http://localhost:5173",
      goal: uiTarget.goal,
    });
  });

  it("fails the visual check rather than skipping it when there is no URL", async () => {
    const result = await verifyCodingTaskAcceptance(
      {
        target: uiTarget,
        baseline: snapshot({ "src/App.tsx": "before" }),
        workerReportedSuccess: true,
        appId: 7,
      },
      deps({
        ensurePreview: vi.fn(async () => ({
          ready: false,
          previewUrl: null,
          error: "the project has no package.json",
        })),
      }),
    );
    const visual = result.evidence.checks.find(
      (check) => check.check === "visual",
    );
    expect(visual?.status).toBe("failed");
    expect(visual?.detail).toContain("no live preview URL");
    expect(result.decision.accepted).toBe(false);
  });

  it("does not render anything for backend work", async () => {
    const inspectRoute = vi.fn(async () => inspection());
    const target = deriveCodingTaskAcceptanceTarget({
      goal: "Add retry logic to the queue consumer",
      projectRoot: "C:/workspace/api",
      targetPaths: ["src"],
    });
    const result = await verifyCodingTaskAcceptance(
      {
        target,
        baseline: snapshot({ "src/App.tsx": "before" }),
        workerReportedSuccess: true,
        appId: 7,
      },
      deps({ inspectRoute }),
    );
    expect(inspectRoute).not.toHaveBeenCalled();
    expect(result.decision.accepted).toBe(true);
  });

  it("fails a required check the project has no command for", async () => {
    const target = deriveCodingTaskAcceptanceTarget({
      goal: "Fix the failing test in the parser",
      projectRoot: "C:/workspace/api",
      targetPaths: ["src"],
    });
    const result = await verifyCodingTaskAcceptance(
      {
        target,
        baseline: snapshot({ "src/App.tsx": "before" }),
        workerReportedSuccess: true,
      },
      deps({
        detectStack: vi.fn(async () => STACK), // `test` is null in STACK
      }),
    );
    const test = result.evidence.checks.find((check) => check.check === "test");
    expect(test?.status).toBe("failed");
    expect(test?.detail).toContain("No test command");
  });

  it("never marks a check as worker-sourced", async () => {
    // The whole contract rests on `source: "orion"`; a worker-sourced check is
    // ignored by `evaluateCodingTaskAcceptance`, so producing one here would
    // silently make the gate unsatisfiable.
    const result = await verifyCodingTaskAcceptance(
      {
        target: uiTarget,
        baseline: snapshot({ "src/App.tsx": "before" }),
        workerReportedSuccess: true,
        appId: 7,
      },
      deps(),
    );
    expect(
      result.evidence.checks.every((check) => check.source === "orion"),
    ).toBe(true);
  });

  it("installs dependencies before building a fresh project", async () => {
    // The live run that motivated this: a newly scaffolded app failed `build`
    // with "Cannot find package 'vite'" no matter what the worker did, because
    // `node_modules` had never been created. A gate that always fails teaches
    // the user to ignore it.
    const runCommand = vi.fn(async (_command: string, _root: string) => ({
      ok: true,
      output: "ok",
    }));
    await verifyCodingTaskAcceptance(
      {
        target: uiTarget,
        baseline: snapshot({ "src/App.tsx": "before" }),
        workerReportedSuccess: true,
        appId: 7,
      },
      deps({ runCommand, fileExists: freshProject() }),
    );
    expect(runCommand.mock.calls.map(([command]) => command)).toEqual([
      "npm install",
      "npm run build",
    ]);
  });

  it("says so plainly when there is no install command to run", async () => {
    const stackWithoutInstall = {
      commands: {
        install: null,
        build: "npm run build",
        typecheck: null,
        test: null,
      },
    } as unknown as ProjectStackDetection;
    const result = await verifyCodingTaskAcceptance(
      {
        target: uiTarget,
        baseline: snapshot({ "src/App.tsx": "before" }),
        workerReportedSuccess: true,
        appId: 7,
      },
      deps({
        detectStack: vi.fn(async () => stackWithoutInstall),
        fileExists: freshProject(),
      }),
    );
    expect(result.decision.accepted).toBe(false);
    expect(result.evidence.checks[0].detail).toContain(
      "No install command was detected",
    );
  });

  it("does not reinstall when node_modules already exists", async () => {
    // Re-installing on every verification would add a minute to every task and
    // could rewrite a lockfile the worker deliberately edited.
    const runCommand = vi.fn(async () => ({ ok: true, output: "ok" }));
    await verifyCodingTaskAcceptance(
      {
        target: uiTarget,
        baseline: snapshot({ "src/App.tsx": "before" }),
        workerReportedSuccess: true,
        appId: 7,
      },
      deps({ runCommand }),
    );
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("stops at a failed install and names the real cause once", async () => {
    const runCommand = vi.fn(async (command: string) =>
      command.includes("install")
        ? { ok: false, output: "ERR_SOCKET_TIMEOUT" }
        : { ok: true, output: "ok" },
    );
    const inspectRoute = vi.fn(async () => inspection());
    const result = await verifyCodingTaskAcceptance(
      {
        target: uiTarget,
        baseline: snapshot({ "src/App.tsx": "before" }),
        workerReportedSuccess: true,
        appId: 7,
      },
      deps({ runCommand, inspectRoute, fileExists: freshProject() }),
    );

    expect(result.decision.accepted).toBe(false);
    expect(result.evidence.checks).toHaveLength(1);
    expect(result.evidence.checks[0]).toMatchObject({
      check: "build",
      status: "failed",
    });
    expect(result.evidence.checks[0].detail).toContain("ERR_SOCKET_TIMEOUT");
    // No cascade of "cannot find package" failures that all describe the same
    // thing, and no pointless preview start.
    expect(inspectRoute).not.toHaveBeenCalled();
  });

  it("does not install for read-only investigation", async () => {
    const runCommand = vi.fn(async () => ({ ok: true, output: "ok" }));
    const target = deriveCodingTaskAcceptanceTarget({
      goal: "Review the routing setup",
      projectRoot: "C:/workspace/site",
      readOnly: true,
    });
    await verifyCodingTaskAcceptance(
      {
        target,
        baseline: snapshot({}),
        workerReportedSuccess: true,
      },
      deps({ runCommand, fileExists: freshProject() }),
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("refuses to run without a trusted project root", async () => {
    await expect(
      verifyCodingTaskAcceptance(
        {
          target: { ...uiTarget, projectRoot: undefined },
          baseline: snapshot({}),
          workerReportedSuccess: true,
        },
        deps(),
      ),
    ).rejects.toThrow("no trusted project root");
  });
});
