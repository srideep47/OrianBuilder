import { describe, expect, it } from "vitest";

import { buildInterruptedRunRecoveryMetadata } from "@/ipc/utils/mission_recovery";

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
});
