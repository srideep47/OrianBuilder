import { describe, expect, it } from "vitest";

import {
  buildMissionInterruptMessage,
  formatMissionInterruptsForInjection,
  type MissionInterruptRecord,
} from "@/ipc/utils/mission_interrupts";

function interrupt(
  overrides: Partial<MissionInterruptRecord>,
): MissionInterruptRecord {
  return {
    id: 1,
    missionId: 2,
    source: "user",
    title: "Update scope",
    body: "Add the export button before continuing.",
    status: "pending",
    metadata: null,
    createdAt: new Date("2026-05-05T10:00:00.000Z"),
    injectedAt: null,
    ...overrides,
  };
}

describe("mission interrupts", () => {
  it("formats pending interrupts as a safe step-boundary update", () => {
    expect(
      formatMissionInterruptsForInjection([
        interrupt({}),
        interrupt({
          id: 2,
          source: "worker",
          title: "Worker complete",
          body: "QA reported a failing console check.",
        }),
      ]),
    ).toContain(
      "[worker] Worker complete: QA reported a failing console check.",
    );
  });

  it("builds a user message for model-loop injection", () => {
    expect(buildMissionInterruptMessage([interrupt({})])).toMatchObject({
      role: "user",
      content: expect.stringContaining("Mission interrupt queue"),
    });
    expect(buildMissionInterruptMessage([])).toBeNull();
  });
});
