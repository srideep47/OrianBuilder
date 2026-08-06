import { describe, expect, it } from "vitest";

import { FlowArtifactBus } from "./artifact_bus";

describe("FlowArtifactBus", () => {
  it("publishes conventional outputs and resolves downstream references", () => {
    const bus = new FlowArtifactBus("flow-1");
    const published = bus.publish("texture", "generate_image", {
      outputPath: "D:/work/stone.png",
    });

    expect(published).toMatchObject([
      { producerStepId: "texture", kind: "image", uri: "D:/work/stone.png" },
    ]);
    expect(
      bus.resolveInput({
        image: { $artifact: "texture" },
        also: "artifact://texture",
      }),
    ).toEqual({ image: "D:/work/stone.png", also: "D:/work/stone.png" });
  });

  it("rehydrates artifacts and selects an indexed output", () => {
    const first = new FlowArtifactBus("flow-1");
    first.publish("build", "build_game", {
      artifactPaths: ["D:/build/game.exe", "D:/build/data.pck"],
    });
    const resumed = new FlowArtifactBus("flow-1", first.list());

    expect(resumed.resolve("build", 1)).toBe("D:/build/data.pck");
  });

  it("fails loudly for an unresolved reference", () => {
    const bus = new FlowArtifactBus("flow-1");
    expect(() => bus.resolveInput("artifact://missing")).toThrow(
      'Artifact reference "missing" did not resolve',
    );
  });
});
