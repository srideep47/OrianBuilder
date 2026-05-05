import { describe, expect, it } from "vitest";

import {
  buildMissionWorkerBranchName,
  buildMissionWorkerPromptPackage,
  buildMissionWorkerWorktreePath,
  sanitizeWorkerIdentifier,
} from "@/ipc/utils/mission_workspace_provider";

describe("mission workspace provider", () => {
  it("sanitizes worker identifiers for branches and paths", () => {
    expect(sanitizeWorkerIdentifier("Builder UI/Main #1")).toBe(
      "builder-ui-main-1",
    );
    expect(sanitizeWorkerIdentifier("   ")).toBe("worker");
  });

  it("builds deterministic worker branch names", () => {
    expect(
      buildMissionWorkerBranchName({
        missionId: 42,
        workerKey: "builder-ui",
      }),
    ).toBe("orian/mission-42/builder-ui");
  });

  it("builds worktree paths outside the app checkout", () => {
    expect(
      buildMissionWorkerWorktreePath({
        appPath: "D:\\apps\\crm-app",
        missionId: 7,
        workerKey: "qa/mobile",
      }).replace(/\\/g, "/"),
    ).toBe("D:/apps/.orian-worker-worktrees/crm-app/mission-7/qa-mobile");
  });

  it("builds a worker handoff prompt package", () => {
    expect(
      buildMissionWorkerPromptPackage({
        missionId: 9,
        worker: {
          workerKey: "builder-ui",
          role: "builder",
          title: "Build UI",
          goal: "Implement the dashboard",
          workspaceProvider: "worktree",
          workspaceRef:
            "D:/apps/.orian-worker-worktrees/app/mission-9/builder-ui",
          branchName: "orian/mission-9/builder-ui",
          fileScopes: ["src/components"],
          dependsOn: ["planner"],
        },
      }),
    ).toContain("Completion report required:");
  });
});
