import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createMediaAssetWorker } from "./asset_worker";
import { HARDWARE_MODEL_PROFILES } from "./model_profiles";
import { AssetSpecSchema } from "@/ipc/types/manifest";
import type {
  MediaGenerationRequest,
  MediaGenerationResult,
} from "@/main/ipc/utils/model_orchestrator";
import type { GenerateAssetArgs } from "./pipeline_orchestrator";

const PROFILE = HARDWARE_MODEL_PROFILES[0];
let mediaDir: string;

beforeAll(async () => {
  mediaDir = path.join(os.tmpdir(), `orion-aw-${Date.now()}`);
  await fs.mkdir(mediaDir, { recursive: true });
});

function asset(over: Record<string, unknown>) {
  return AssetSpecSchema.parse({
    id: "a",
    type: "image",
    targetFilename: "assets/a.png",
    prompt: "p",
    ...over,
  });
}

function args(over: Partial<GenerateAssetArgs>): GenerateAssetArgs {
  return {
    asset: asset({}),
    profile: PROFILE,
    mediaDir,
    ...over,
  };
}

describe("createMediaAssetWorker — routing + mapping", () => {
  it("routes image to dispatch with merged settings and deterministic path", async () => {
    let captured: MediaGenerationRequest | null = null;
    const worker = createMediaAssetWorker({
      dispatch: async (req): Promise<MediaGenerationResult> => {
        captured = req;
        return { success: true, outputPath: req.outputPath, durationMs: 1 };
      },
    });
    const res = await worker(
      args({ asset: asset({ settings: { steps: 8 } }) }),
    );
    expect(res.status).toBe("done");
    expect(captured!.modelType).toBe("image");
    // profile default (guidance/width/height) merged with asset override (steps=8)
    expect(captured!.options).toMatchObject({ steps: 8, guidance: 4.0 });
    expect(captured!.outputPath).toBe(path.join(mediaDir, "assets/a.png"));
  });

  it("routes speech asset to the audio (TTS) path with the profile model id", async () => {
    let captured: MediaGenerationRequest | null = null;
    const worker = createMediaAssetWorker({
      dispatch: async (req) => {
        captured = req;
        return { success: true, outputPath: req.outputPath, durationMs: 1 };
      },
    });
    await worker(
      args({
        asset: asset({
          type: "speech",
          targetFilename: "vo.wav",
          prompt: "narration",
        }),
      }),
    );
    expect(captured!.modelType).toBe("audio");
    expect(captured!.modelId).toBe(PROFILE.speech.modelId);
  });

  it("maps music asset to modelType music", async () => {
    let captured: MediaGenerationRequest | null = null;
    const worker = createMediaAssetWorker({
      dispatch: async (req) => {
        captured = req;
        return { success: true, outputPath: req.outputPath, durationMs: 1 };
      },
    });
    await worker(
      args({
        asset: asset({
          type: "music",
          targetFilename: "s.wav",
          prompt: "song",
        }),
      }),
    );
    expect(captured!.modelType).toBe("music");
  });

  it("classifies a placeholder dispatch result as placeholder", async () => {
    const worker = createMediaAssetWorker({
      dispatch: async (req) => ({
        success: true,
        outputPath: req.outputPath,
        durationMs: 1,
        error: "placeholder (no real provider available)",
      }),
    });
    const res = await worker(args({}));
    expect(res.status).toBe("placeholder");
  });

  it("maps an unsuccessful video result to failed", async () => {
    const worker = createMediaAssetWorker({
      dispatch: async (req) => ({
        success: false,
        outputPath: req.outputPath,
        durationMs: 1,
        error: "video backend unavailable",
      }),
    });
    const res = await worker(
      args({
        asset: asset({ type: "video", targetFilename: "c.mp4", prompt: "v" }),
      }),
    );
    expect(res.status).toBe("failed");
    expect(res.error).toContain("video backend unavailable");
  });
});

describe("createMediaAssetWorker — 3D", () => {
  it("fails gracefully when no 3D backend is wired", async () => {
    const worker = createMediaAssetWorker({
      dispatch: async (req) => ({
        success: true,
        outputPath: req.outputPath,
        durationMs: 1,
      }),
    });
    const res = await worker(
      args({
        asset: asset({ type: "3d", targetFilename: "m.glb", prompt: "3d" }),
      }),
    );
    expect(res.status).toBe("failed");
    expect(res.error).toBe("3d-backend-not-wired");
  });

  it("passes refImagePath to the 3D backend and returns done", async () => {
    let capturedRef: string | undefined;
    const worker = createMediaAssetWorker({
      dispatch: async (req) => ({
        success: true,
        outputPath: req.outputPath,
        durationMs: 1,
      }),
      generate3d: async ({ refImagePath, outputPath }) => {
        capturedRef = refImagePath;
        return { success: true, outputPath };
      },
    });
    const res = await worker(
      args({
        asset: asset({ type: "3d", targetFilename: "m.glb", prompt: "3d" }),
        refImagePath: "/out/ref.png",
      }),
    );
    expect(res.status).toBe("done");
    expect(capturedRef).toBe("/out/ref.png");
  });
});
