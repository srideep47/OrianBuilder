import { describe, expect, it } from "vitest";

import {
  buildInterruptedRunRecoveryMetadata,
  buildInterruptedWorkerRecoveryMetadata,
} from "@/ipc/utils/mission_recovery";

describe("mission recovery", () => {
  it("builds paused metadata for interrupted runs when auto-resume is off", () => {
    expect(
      buildInterruptedRunRecoveryMetadata({
        run: {
          id: 42,
          missionId: 7,
          chatId: 3,
          messageId: 9,
          totalStepsExecuted: 12,
          startedAt: new Date("2026-05-04T10:00:00.000Z"),
        },
        recoveredAt: new Date("2026-05-04T10:05:00.000Z"),
        autoResume: false,
      }),
    ).toEqual({
      runId: 42,
      chatId: 3,
      messageId: 9,
      recovery: "paused_for_resume",
      autoResume: false,
      recoveredAt: "2026-05-04T10:05:00.000Z",
      interruptedRunStartedAt: "2026-05-04T10:00:00.000Z",
      totalStepsExecuted: 12,
    });
  });

  it("flags interrupted runs for auto-resume when enabled", () => {
    expect(
      buildInterruptedRunRecoveryMetadata({
        run: {
          id: 100,
          missionId: 7,
          chatId: 3,
          messageId: 9,
          totalStepsExecuted: 5,
          startedAt: new Date("2026-05-04T10:00:00.000Z"),
        },
        recoveredAt: new Date("2026-05-04T10:05:00.000Z"),
        autoResume: true,
      }).recovery,
    ).toBe("auto_resume_queued");
  });

  it("builds retryable metadata for interrupted workers", () => {
    expect(
      buildInterruptedWorkerRecoveryMetadata({
        worker: {
          id: 11,
          missionId: 7,
          workerKey: "builder-ui",
          role: "builder",
          workspaceProvider: "worktree",
          workspaceRef:
            "D:/apps/.orian-worker-worktrees/app/mission-7/builder-ui",
          branchName: "orian/mission-7/builder-ui",
          metadata: null,
          startedAt: new Date("2026-05-04T10:01:00.000Z"),
          updatedAt: new Date("2026-05-04T10:03:00.000Z"),
        },
        recoveredAt: new Date("2026-05-04T10:05:00.000Z"),
        autoResume: false,
      }),
    ).toEqual({
      workerId: 11,
      workerKey: "builder-ui",
      role: "builder",
      workspaceProvider: "worktree",
      workspaceRef: "D:/apps/.orian-worker-worktrees/app/mission-7/builder-ui",
      branchName: "orian/mission-7/builder-ui",
      recovery: "worker_failed_for_retry",
      autoResume: false,
      recoveredAt: "2026-05-04T10:05:00.000Z",
      interruptedWorkerStartedAt: "2026-05-04T10:01:00.000Z",
      interruptedWorkerUpdatedAt: "2026-05-04T10:03:00.000Z",
    });
  });
});
