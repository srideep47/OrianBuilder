import { describe, it, expect } from "vitest";
import {
  generateAssetManifest,
  buildPlannerSystemPrompt,
} from "./asset_planner";
import { HARDWARE_MODEL_PROFILES } from "./model_profiles";

const PROFILE = HARDWARE_MODEL_PROFILES[0];

function planner(out: string) {
  return generateAssetManifest({
    buildId: "b1",
    goal: "a coffee shop landing page",
    profile: PROFILE,
    generate: async () => out,
  });
}

describe("buildPlannerSystemPrompt", () => {
  it("lists the supported modalities and the JSON contract", () => {
    const p = buildPlannerSystemPrompt(PROFILE);
    expect(p).toContain("image, video, music, 3d");
    expect(p).toContain("targetFilename");
    expect(p).toContain("refAssetId");
  });
});

describe("generateAssetManifest", () => {
  it("parses a clean manifest and stamps the buildId", async () => {
    const m = await planner(
      JSON.stringify({
        assets: [
          {
            id: "logo",
            type: "image",
            targetFilename: "assets/logo.png",
            prompt: "a logo",
          },
        ],
      }),
    );
    expect(m.buildId).toBe("b1");
    expect(m.assets).toHaveLength(1);
    expect(m.assets[0].status).toBe("pending");
    expect(m.assets[0].settings).toEqual({});
  });

  it("strips markdown fences", async () => {
    const m = await planner(
      '```json\n{"assets":[{"id":"a","type":"image","targetFilename":"a.png","prompt":"x"}]}\n```',
    );
    expect(m.assets).toHaveLength(1);
  });

  it("repairs slightly malformed JSON (trailing comma)", async () => {
    const m = await planner(
      '{"assets":[{"id":"a","type":"image","targetFilename":"a.png","prompt":"x"},]}',
    );
    expect(m.assets).toHaveLength(1);
  });

  it("accepts a bare array as well as {assets:[...]}", async () => {
    const m = await planner(
      '[{"id":"a","type":"image","targetFilename":"a.png","prompt":"x"}]',
    );
    expect(m.assets).toHaveLength(1);
  });

  it("returns an empty manifest when the LLM throws", async () => {
    const m = await generateAssetManifest({
      buildId: "b2",
      goal: "x",
      profile: PROFILE,
      generate: async () => {
        throw new Error("offline");
      },
    });
    expect(m).toEqual({ buildId: "b2", assets: [] });
  });

  it("returns an empty manifest on non-JSON output", async () => {
    const m = await planner("I cannot help with that.");
    expect(m.assets).toEqual([]);
  });

  it("keeps a structurally-questionable manifest rather than aborting", async () => {
    // 3d referencing a non-existent asset → validateManifest flags it, but we
    // still return the parsed manifest (build proceeds, gap handled downstream).
    const m = await planner(
      JSON.stringify({
        assets: [
          {
            id: "mesh",
            type: "3d",
            targetFilename: "m.glb",
            prompt: "3d",
            refAssetId: "missing",
          },
        ],
      }),
    );
    expect(m.assets).toHaveLength(1);
  });
});
