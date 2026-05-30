import { describe, it, expect } from "vitest";
import { ModelGate } from "./model_gate";
import { HARDWARE_MODEL_PROFILES } from "./model_profiles";
import {
  runPipeline,
  type PipelineConfig,
  type PipelineWorkers,
  type GenerateAssetArgs,
} from "./pipeline_orchestrator";
import { AssetManifestSchema, type AssetManifest } from "@/ipc/types/manifest";

const PROFILE = HARDWARE_MODEL_PROFILES[0];

function makeGate(events: string[]): ModelGate {
  const gate = new ModelGate();
  gate.setHooks({
    load: async (s) => {
      events.push(`load:${s.kind}`);
    },
    unload: async (s) => {
      events.push(`unload:${s.kind}`);
    },
  });
  return gate;
}

function baseManifest(assets: unknown[]): AssetManifest {
  return AssetManifestSchema.parse({ buildId: "b", assets });
}

function makeConfig(
  overrides: Partial<PipelineConfig> & { workers: PipelineWorkers },
  events: string[],
): PipelineConfig {
  return {
    goal: "build a landing page",
    mediaDir: "/tmp/media",
    profile: PROFILE,
    gate: makeGate(events),
    llmModelId: "qwen2.5-vl",
    ...overrides,
  };
}

describe("runPipeline — happy path", () => {
  it("sequences plan→assets→verify with single residency and correct order", async () => {
    const events: string[] = [];
    const genCalls: string[] = [];

    const manifest = baseManifest([
      { id: "song", type: "music", targetFilename: "s.wav", prompt: "m" },
      { id: "clip", type: "video", targetFilename: "c.mp4", prompt: "v" },
      { id: "hero", type: "image", targetFilename: "hero.png", prompt: "i" },
    ]);

    const workers: PipelineWorkers = {
      planCode: async () => manifest,
      generateAsset: async ({ asset }: GenerateAssetArgs) => {
        genCalls.push(asset.id);
        return { status: "done", outputPath: `/out/${asset.targetFilename}` };
      },
      verifyFix: async () => ({ ok: true, report: "looks good" }),
    };

    const res = await runPipeline(makeConfig({ workers }, events));

    expect(res.status).toBe("completed");
    expect(res.assetSummary).toEqual({ done: 3, placeholder: 0, failed: 0 });
    // Assets generated in modality order: image → video → music.
    expect(genCalls).toEqual(["hero", "clip", "song"]);
    // Gate timeline: LLM (plan) → exit → image → video → music → exit → LLM (verify) → exit.
    expect(events).toEqual([
      "load:llm",
      "unload:llm",
      "load:image",
      "unload:image",
      "load:video",
      "unload:video",
      "load:music",
      "unload:music",
      "load:llm",
      "unload:llm",
    ]);
  });
});

describe("runPipeline — 3D reference resolution", () => {
  it("passes the referenced image's output path to the 3D asset", async () => {
    const events: string[] = [];
    let captured: GenerateAssetArgs | null = null;

    const manifest = baseManifest([
      { id: "ref", type: "image", targetFilename: "ref.png", prompt: "i" },
      {
        id: "mesh",
        type: "3d",
        targetFilename: "mesh.glb",
        prompt: "3d",
        refAssetId: "ref",
      },
    ]);

    const workers: PipelineWorkers = {
      planCode: async () => manifest,
      generateAsset: async (args) => {
        if (args.asset.id === "mesh") captured = args;
        return {
          status: "done",
          outputPath: `/out/${args.asset.targetFilename}`,
        };
      },
      verifyFix: async () => ({ ok: true }),
    };

    await runPipeline(makeConfig({ workers }, events));
    expect(captured!.refImagePath).toBe("/out/ref.png");
    // image batch runs (and unloads) before the 3d batch loads.
    expect(events).toEqual([
      "load:llm",
      "unload:llm",
      "load:image",
      "unload:image",
      "load:3d",
      "unload:3d",
      "load:llm",
      "unload:llm",
    ]);
  });
});

describe("runPipeline — resilience", () => {
  it("does not block the build when an asset fails; status is partial", async () => {
    const events: string[] = [];
    const manifest = baseManifest([
      { id: "ok", type: "image", targetFilename: "ok.png", prompt: "i" },
      { id: "bad", type: "image", targetFilename: "bad.png", prompt: "i2" },
    ]);
    const workers: PipelineWorkers = {
      planCode: async () => manifest,
      generateAsset: async ({ asset }) =>
        asset.id === "bad"
          ? { status: "placeholder", outputPath: "/out/bad.png" }
          : { status: "done", outputPath: "/out/ok.png" },
      verifyFix: async () => ({ ok: true }),
    };
    const res = await runPipeline(makeConfig({ workers }, events));
    expect(res.status).toBe("partial");
    expect(res.assetSummary).toEqual({ done: 1, placeholder: 1, failed: 0 });
  });

  it("treats a thrown generateAsset as failed, not fatal", async () => {
    const events: string[] = [];
    const manifest = baseManifest([
      { id: "boom", type: "image", targetFilename: "x.png", prompt: "i" },
    ]);
    const workers: PipelineWorkers = {
      planCode: async () => manifest,
      generateAsset: async () => {
        throw new Error("backend down");
      },
      verifyFix: async () => ({ ok: true }),
    };
    const res = await runPipeline(makeConfig({ workers }, events));
    expect(res.assetSummary.failed).toBe(1);
    expect(res.status).toBe("partial");
  });

  it("returns failed when plan-code throws", async () => {
    const events: string[] = [];
    const workers: PipelineWorkers = {
      planCode: async () => {
        throw new Error("LLM offline");
      },
      generateAsset: async () => ({ status: "done" }),
      verifyFix: async () => ({ ok: true }),
    };
    const res = await runPipeline(makeConfig({ workers }, events));
    expect(res.status).toBe("failed");
    expect(res.phases[0]).toMatchObject({
      phase: "plan-code",
      status: "failed",
    });
    // LLM was loaded then unloaded on the failure path.
    expect(events).toEqual(["load:llm", "unload:llm"]);
  });
});

describe("runPipeline — bounded regen loop", () => {
  it("regenerates only requested assets, then re-verifies to completion", async () => {
    const events: string[] = [];
    const regenCounts = new Map<string, number>();
    const manifest = baseManifest([
      { id: "hero", type: "image", targetFilename: "hero.png", prompt: "i" },
      { id: "icon", type: "image", targetFilename: "icon.png", prompt: "i2" },
    ]);

    let verifyCall = 0;
    const workers: PipelineWorkers = {
      planCode: async () => manifest,
      generateAsset: async ({ asset }) => {
        regenCounts.set(asset.id, (regenCounts.get(asset.id) ?? 0) + 1);
        return { status: "done", outputPath: `/out/${asset.targetFilename}` };
      },
      verifyFix: async () => {
        verifyCall++;
        // First pass: ask to regen "icon" only. Second pass: ok.
        return verifyCall === 1
          ? { ok: false, regenAssetIds: ["icon"], report: "icon blurry" }
          : { ok: true, report: "fixed" };
      },
    };

    const res = await runPipeline(makeConfig({ workers }, events));
    expect(res.status).toBe("completed");
    expect(res.verifyAttempts).toBe(2);
    // hero generated once; icon generated twice (initial + regen).
    expect(regenCounts.get("hero")).toBe(1);
    expect(regenCounts.get("icon")).toBe(2);
  });

  it("stops after maxVerifyAttempts and reports partial", async () => {
    const events: string[] = [];
    const manifest = baseManifest([
      { id: "hero", type: "image", targetFilename: "hero.png", prompt: "i" },
    ]);
    const workers: PipelineWorkers = {
      planCode: async () => manifest,
      generateAsset: async ({ asset }) => ({
        status: "done",
        outputPath: `/out/${asset.targetFilename}`,
      }),
      // Never satisfied, always asks for regen.
      verifyFix: async () => ({ ok: false, regenAssetIds: ["hero"] }),
    };
    const res = await runPipeline(
      makeConfig({ workers, maxVerifyAttempts: 2 }, events),
    );
    expect(res.status).toBe("partial");
    expect(res.verifyAttempts).toBe(2);
  });

  it("stops looping when verify fails but requests no regen", async () => {
    const events: string[] = [];
    const manifest = baseManifest([
      { id: "hero", type: "image", targetFilename: "hero.png", prompt: "i" },
    ]);
    let verifyCall = 0;
    const workers: PipelineWorkers = {
      planCode: async () => manifest,
      generateAsset: async ({ asset }) => ({
        status: "done",
        outputPath: `/out/${asset.targetFilename}`,
      }),
      verifyFix: async () => {
        verifyCall++;
        return { ok: false, report: "code issue I cannot fix" };
      },
    };
    const res = await runPipeline(makeConfig({ workers }, events));
    expect(res.status).toBe("partial");
    expect(verifyCall).toBe(1);
  });
});
