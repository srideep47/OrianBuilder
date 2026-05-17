import { describe, expect, it } from "vitest";

import { buildMissionTaskSyncRows } from "@/ipc/utils/mission_tasks";

describe("mission task sync rows", () => {
  it("maps agent todos into ordered mission task rows", () => {
    const now = new Date("2026-05-04T00:00:00.000Z");

    expect(
      buildMissionTaskSyncRows(
        [
          {
            id: "plan",
            content: "Plan the feature",
            status: "completed",
          },
          {
            id: "build",
            content: "Build the feature",
            status: "in_progress",
          },
        ],
        now,
      ),
    ).toEqual([
      {
        externalId: "plan",
        title: "Plan the feature",
        status: "completed",
        orderIndex: 0,
        completedAt: now,
      },
      {
        externalId: "build",
        title: "Build the feature",
        status: "in_progress",
        orderIndex: 1,
        completedAt: null,
      },
    ]);
  });
});
