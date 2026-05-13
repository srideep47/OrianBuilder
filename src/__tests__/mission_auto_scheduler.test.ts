import { describe, expect, it } from "vitest";

import { getMissionAutoAdvanceAction } from "@/ipc/utils/mission_auto_scheduler";

type MissionInput = Parameters<
  typeof getMissionAutoAdvanceAction
>[0]["mission"];
type WorkerInput = Parameters<
  typeof getMissionAutoAdvanceAction
>[0]["workers"][number];

const autoMission: MissionInput = {
  autonomyProfile: "full-autopilot-sandbox",
  chatId: 10,
  status: "running",
};

function worker(input: Partial<WorkerInput> & { workerKey: string }) {
  return {
    status: "queued",
    dependsOn: null,
    workspaceRef: null,
    ...input,
  } satisfies WorkerInput;
}

describe("mission auto scheduler", () => {
  it("dispatches queued workers with satisfied dependencies", () => {
    expect(
      getMissionAutoAdvanceAction({
        mission: autoMission,
        workers: [
          worker({ workerKey: "planner", status: "completed" }),
          worker({
            workerKey: "builder",
            dependsOn: ["planner"],
          }),
        ],
      }),
    ).toEqual({ type: "dispatch", workerKeys: ["builder"] });
  });

  it("prepares ready workers before running them", () => {
    expect(
      getMissionAutoAdvanceAction({
        mission: autoMission,
        workers: [
          worker({ workerKey: "planner", status: "completed" }),
          worker({
            workerKey: "builder",
            status: "ready",
            dependsOn: ["planner"],
            workspaceRef: null,
          }),
        ],
      }),
    ).toEqual({ type: "prepare", workerKeys: ["builder"] });
  });

  it("runs ready workers after their workspace is prepared", () => {
    expect(
      getMissionAutoAdvanceAction({
        mission: autoMission,
        workers: [
          worker({ workerKey: "planner", status: "completed" }),
          worker({
            workerKey: "builder",
            status: "ready",
            dependsOn: ["planner"],
            workspaceRef: "D:/apps/.orian-worker-worktrees/app/builder",
          }),
        ],
      }),
    ).toEqual({ type: "run", workerKeys: ["builder"] });
  });

  it("does not auto-advance supervised missions", () => {
    expect(
      getMissionAutoAdvanceAction({
        mission: {
          ...autoMission,
          autonomyProfile: "supervised",
        },
        workers: [worker({ workerKey: "builder" })],
      }),
    ).toEqual({ type: "skip", reason: "mission_not_auto_advanceable" });
  });

  it("stays idle while dependencies are incomplete", () => {
    expect(
      getMissionAutoAdvanceAction({
        mission: autoMission,
        workers: [
          worker({ workerKey: "planner", status: "running" }),
          worker({
            workerKey: "builder",
            dependsOn: ["planner"],
          }),
        ],
      }),
    ).toEqual({ type: "idle", reason: "no_auto_action_available" });
  });
});
