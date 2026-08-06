import { describe, expect, it } from "vitest";

import {
  deriveCodingTaskAcceptanceTarget,
  evaluateCodingTaskAcceptance,
  projectRelativeEvidencePath,
  renderCodingTaskAcceptanceInstructions,
} from "./task_acceptance";

describe("coding-task acceptance", () => {
  const target = deriveCodingTaskAcceptanceTarget({
    goal: "Build a polished website page",
    projectRoot: "C:/workspace/site",
    targetPaths: ["src", "index.html", "package.json"],
  });

  it("does not accept a worker success report by itself", () => {
    expect(
      evaluateCodingTaskAcceptance(target, {
        workerReportedSuccess: true,
        observedChangedFiles: [],
        checks: [],
      }),
    ).toMatchObject({
      accepted: false,
      status: "pending-evidence",
      missingEvidence: [
        "a relevant workspace change",
        "build verification",
        "preview verification",
        "visual verification",
      ],
    });
  });

  it("requires an on-screen check for UI work, not just a live server", () => {
    // A healthy preview server proves a server is answering. It does not prove
    // the requested change is on the page the user is looking at.
    expect(target.requiredChecks).toContain("preview");
    expect(target.requiredChecks).toContain("visual");
  });

  it("asks for no visual check when nothing is rendered", () => {
    const backend = deriveCodingTaskAcceptanceTarget({
      goal: "Add retry logic to the queue consumer",
      projectRoot: "C:/workspace/api",
    });
    expect(backend.requiredChecks).not.toContain("visual");
    expect(backend.requiredChecks).not.toContain("preview");
  });

  it("recognises the requests people actually make as UI work", () => {
    // Every one of these is something a person will look at. "Change the
    // homepage heading" matched none of the original alternatives — `\bpage\b`
    // does not match inside "homepage" — so the on-screen check silently never
    // ran for the single most ordinary request there is.
    for (const goal of [
      'Change the homepage heading text to "Rainbow Hello"',
      "Make the navbar sticky",
      "Add a footer with a link to the docs",
      "Fix the button colour on the pricing page",
      "Add a dark mode toggle",
      "Make the layout responsive",
      "Add a hero banner",
      "Update the logo",
    ]) {
      expect(
        deriveCodingTaskAcceptanceTarget({ goal }).requiredChecks,
        goal,
      ).toContain("visual");
    }
  });

  it("does not mistake common words for UI work", () => {
    // The bounded alternation matters: "form" inside "perform", "card" inside
    // "discard". A false positive costs a preview start and an offscreen render
    // on every backend task.
    for (const goal of [
      "Perform a database migration",
      "Discard the stale cache entries",
      "Add retry logic to the queue consumer",
      "Rename the transform helper",
      "Log more information about failed jobs",
    ]) {
      expect(
        deriveCodingTaskAcceptanceTarget({ goal }).requiredChecks,
        goal,
      ).not.toContain("visual");
    }
  });

  it("tells the worker to modify the live app and produce required evidence", () => {
    const instructions = renderCodingTaskAcceptanceInstructions(target);
    expect(instructions).toContain("active entry points");
    expect(instructions).toContain("unused standalone demo file");
    expect(instructions).toContain("build");
    expect(instructions).toContain("preview");
  });

  it("rejects an orphan file even when build and preview pass", () => {
    const decision = evaluateCodingTaskAcceptance(target, {
      workerReportedSuccess: true,
      observedChangedFiles: ["rainbow-hello.html"],
      checks: [
        { check: "build", status: "passed", source: "orion" },
        { check: "preview", status: "passed", source: "orion" },
      ],
    });
    expect(decision.accepted).toBe(false);
    expect(decision.relevantChangedFiles).toEqual([]);
    expect(decision.missingEvidence).toEqual([
      "a relevant workspace change",
      "visual verification",
    ]);
  });

  it("accepts relevant host-observed changes and trusted verification", () => {
    expect(
      evaluateCodingTaskAcceptance(target, {
        workerReportedSuccess: true,
        observedChangedFiles: ["C:/workspace/site/src/pages/Index.tsx"],
        checks: [
          { check: "build", status: "passed", source: "orion" },
          {
            check: "preview",
            status: "passed",
            source: "orion",
            artifact: "http://localhost:5173",
          },
          {
            check: "visual",
            status: "passed",
            source: "orion",
            artifact: "route-1a2b.png",
          },
        ],
      }),
    ).toMatchObject({
      accepted: true,
      status: "accepted",
      relevantChangedFiles: ["src/pages/Index.tsx"],
      missingEvidence: [],
    });
  });

  it("does not trust checks that only the worker claims", () => {
    const decision = evaluateCodingTaskAcceptance(target, {
      workerReportedSuccess: true,
      observedChangedFiles: ["src/App.tsx"],
      checks: [
        { check: "build", status: "passed", source: "worker" },
        { check: "preview", status: "passed", source: "worker" },
        { check: "visual", status: "passed", source: "worker" },
      ],
    });
    expect(decision.missingEvidence).toEqual([
      "build verification",
      "preview verification",
      "visual verification",
    ]);
  });

  it("fails the task when the live route does not show the change", () => {
    // The `rainbow-hello.html` shape with everything else green: the file is in
    // a targeted directory, build and preview pass, and the page is unchanged.
    const decision = evaluateCodingTaskAcceptance(target, {
      workerReportedSuccess: true,
      observedChangedFiles: ["src/standalone-demo.tsx"],
      checks: [
        { check: "build", status: "passed", source: "orion" },
        { check: "preview", status: "passed", source: "orion" },
        {
          check: "visual",
          status: "failed",
          source: "orion",
          detail: "Not visible at the live route: “rainbow hello”.",
        },
      ],
    });
    expect(decision.accepted).toBe(false);
    expect(decision.status).toBe("failed");
    expect(decision.failedChecks).toEqual(["visual"]);
  });

  it("lets a trusted failed check override optimistic worker prose", () => {
    const decision = evaluateCodingTaskAcceptance(target, {
      workerReportedSuccess: true,
      observedChangedFiles: ["src/App.tsx"],
      checks: [
        { check: "build", status: "failed", source: "orion" },
        { check: "preview", status: "passed", source: "orion" },
      ],
    });
    expect(decision.status).toBe("failed");
    expect(decision.failedChecks).toEqual(["build"]);
  });

  it("rejects traversal and absolute evidence outside the workspace", () => {
    expect(
      projectRelativeEvidencePath("../other/secret.ts", "C:/workspace/site"),
    ).toBeNull();
    expect(
      projectRelativeEvidencePath(
        "C:/workspace/other/secret.ts",
        "C:/workspace/site",
      ),
    ).toBeNull();
  });
});
