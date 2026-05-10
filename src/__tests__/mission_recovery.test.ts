import { describe, expect, it } from "vitest";

import {
  buildInterruptedRunRecoveryMetadata,
  buildInterruptedWorkerRecoveryMetadata,
} from "@/ipc/utils/mission_recovery";

describe("mission recovery", () => {
  it("builds resumable metadata for interrupted runs", () => {
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
      }),
    ).toEqual({
      runId: 42,
      chatId: 3,
      messageId: 9,
      recovery: "paused_for_resume",
      recoveredAt: "2026-05-04T10:05:00.000Z",
      interruptedRunStartedAt: "2026-05-04T10:00:00.000Z",
      totalStepsExecuted: 12,
    });
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
      }),
    ).toEqual({
      workerId: 11,
      workerKey: "builder-ui",
      role: "builder",
      workspaceProvider: "worktree",
      workspaceRef: "D:/apps/.orian-worker-worktrees/app/mission-7/builder-ui",
      branchName: "orian/mission-7/builder-ui",
      recovery: "worker_failed_for_retry",
      recoveredAt: "2026-05-04T10:05:00.000Z",
      interruptedWorkerStartedAt: "2026-05-04T10:01:00.000Z",
      interruptedWorkerUpdatedAt: "2026-05-04T10:03:00.000Z",
    });
  });
});
