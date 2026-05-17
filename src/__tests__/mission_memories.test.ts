import { describe, expect, it } from "vitest";

import {
  buildMissionMemoryMessage,
  formatMissionMemoriesForInjection,
  type MissionMemoryRecord,
} from "@/ipc/utils/mission_memories";

function memory(overrides: Partial<MissionMemoryRecord>): MissionMemoryRecord {
  return {
    id: 1,
    appId: 2,
    missionId: null,
    category: "decision",
    title: "Use worktrees",
    body: "Builder and QA workers should run in isolated worktrees.",
    metadata: null,
    createdAt: new Date("2026-05-05T10:00:00.000Z"),
    updatedAt: new Date("2026-05-05T10:00:00.000Z"),
    ...overrides,
  };
}

describe("mission memories", () => {
  it("formats app and mission scoped records explicitly", () => {
    expect(
      formatMissionMemoriesForInjection([
        memory({}),
        memory({
          id: 2,
          missionId: 7,
          category: "gotcha",
          title: "Do not run tsc",
          body: "Use npm run ts for this repo.",
        }),
      ]),
    ).toContain("[mission:7 gotcha] Do not run tsc");
  });

  it("builds a user message for safe-boundary injection", () => {
    expect(buildMissionMemoryMessage([memory({})])).toMatchObject({
      role: "user",
      content: expect.stringContaining("Mission memory records"),
    });
    expect(buildMissionMemoryMessage([])).toBeNull();
  });
});
