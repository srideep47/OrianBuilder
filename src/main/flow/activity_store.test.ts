import { beforeEach, describe, expect, it } from "vitest";

import {
  _resetFlowActivityForTests,
  listActiveFlowActivities,
  listRecentFlowArtifacts,
  recordFlowActivity,
} from "./activity_store";

beforeEach(_resetFlowActivityForTests);

describe("Harmony activity projection", () => {
  it("tracks live flows until their completion event", () => {
    recordFlowActivity({
      flowId: "flow-1",
      goal: "Build a game",
      label: "Texture",
      status: "running",
      timestamp: 10,
    });
    expect(listActiveFlowActivities()).toEqual([
      {
        flowId: "flow-1",
        goal: "Build a game",
        updatedAt: 10,
      },
    ]);

    recordFlowActivity({
      flowId: "flow-1",
      goal: "Build a game",
      label: "Build a game",
      status: "completed",
      progress: 100,
      timestamp: 20,
    });
    expect(listActiveFlowActivities()).toEqual([]);
  });

  it("keeps newest artifacts available to Marta after the flow completes", () => {
    for (const [id, timestamp] of [
      ["texture", 10],
      ["mesh", 20],
    ] as const) {
      recordFlowActivity({
        flowId: "flow-1",
        goal: "Build a game",
        stepId: id,
        label: id,
        status: "success",
        artifact: {
          id,
          flowId: "flow-1",
          producerStepId: id,
          capability: id === "texture" ? "generate_image" : "process_mesh",
          kind: id === "texture" ? "image" : "mesh",
          label: id,
          uri: `D:/${id}`,
          metadata: {},
          createdAt: timestamp,
        },
        timestamp,
      });
    }

    expect(listRecentFlowArtifacts(1).map((artifact) => artifact.id)).toEqual([
      "mesh",
    ]);
  });
});
