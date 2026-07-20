import { describe, expect, it } from "vitest";
import type { AssetManifest } from "@/ipc/types/manifest";
import {
  compileMediaGraph,
  mediaGraphFromAssetManifest,
  OrionMediaGraphSchema,
  validateMediaGraph,
} from "./orion_media_graph";

function manifest(): AssetManifest {
  return {
    buildId: "build-1",
    assets: [
      {
        id: "mesh",
        type: "3d",
        targetFilename: "assets/mesh.glb",
        prompt: "product mesh",
        settings: {},
        refAssetId: "reference",
        status: "pending",
      },
      {
        id: "reference",
        type: "image",
        targetFilename: "assets/reference.png",
        prompt: "front view",
        settings: { seed: 7 },
        status: "pending",
      },
    ],
  };
}

describe("Orion media graph", () => {
  it("converts the current manifest into a local-first graph", () => {
    const graph = mediaGraphFromAssetManifest(manifest());
    expect(graph.version).toBe(1);
    expect(graph.execution).toEqual({
      placement: "local-first",
      allowPaidFallback: false,
    });
    expect(graph.nodes[0].inputs.reference).toEqual({
      nodeId: "reference",
      output: "artifact",
    });
    expect(graph.nodes[1].parameters).toMatchObject({
      prompt: "front view",
      seed: 7,
    });
  });

  it("compiles stable dependency waves regardless of source order", () => {
    const graph = mediaGraphFromAssetManifest(manifest());
    const plan = compileMediaGraph(graph);
    expect(plan.ok).toBe(true);
    expect(plan.waves).toEqual([["reference"], ["mesh"]]);
    expect(plan.orderedNodeIds).toEqual(["reference", "mesh"]);
  });

  it("rejects cycles, unknown outputs, and unsafe artifact paths", () => {
    const graph = OrionMediaGraphSchema.parse({
      version: 1,
      id: "bad",
      nodes: [
        {
          id: "a",
          operation: "image.upscale",
          inputs: { source: { nodeId: "b", output: "missing" } },
          targetFilename: "../escape.png",
        },
        {
          id: "b",
          operation: "image.inpaint",
          inputs: { source: { nodeId: "a" } },
        },
      ],
    });
    const validation = validateMediaGraph(graph);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        'node "a" has unsafe targetFilename',
        '"a" references unknown output "missing" on node "b"',
        "media graph contains a dependency cycle",
      ]),
    );
  });

  it("describes control, quality, and export nodes without backend coupling", () => {
    const graph = OrionMediaGraphSchema.parse({
      version: 1,
      id: "quality-pipeline",
      nodes: [
        { id: "depth", operation: "preprocess.depth" },
        {
          id: "image",
          operation: "generate.image",
          inputs: { control: { nodeId: "depth" } },
          residency: { kind: "image", modelId: "flux", vramMb: 8192 },
        },
        {
          id: "qa",
          operation: "quality.evaluate",
          inputs: { artifact: { nodeId: "image" } },
        },
        {
          id: "export",
          operation: "artifact.export",
          inputs: { artifact: { nodeId: "image" } },
          targetFilename: "assets/final.png",
        },
      ],
      outputs: { final: { nodeId: "export" } },
    });
    expect(compileMediaGraph(graph).waves).toEqual([
      ["depth"],
      ["image"],
      ["qa", "export"],
    ]);
  });
});
