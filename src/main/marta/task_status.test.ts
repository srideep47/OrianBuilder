import { describe, expect, it } from "vitest";

import { deriveMissionTaskTransition } from "./task_status";

describe("deriveMissionTaskTransition", () => {
  it("uses the worker report status instead of treating every report as success", () => {
    expect(
      deriveMissionTaskTransition({
        currentStatus: "running",
        eventType: "mission_worker_report_submitted",
        metadata: { status: "failed" },
      }).status,
    ).toBe("failed");
  });

  it("does not reopen a completed task when its diff arrives afterward", () => {
    expect(
      deriveMissionTaskTransition({
        currentStatus: "succeeded",
        eventType: "mission_worker_diff_captured",
      }).status,
    ).toBe("succeeded");
  });
});
