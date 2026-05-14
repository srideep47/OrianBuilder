import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  _resetOrchestratorForTests,
  calculateOptimalLlmParams,
  canTransition,
  getOrchestrator,
  pickBestImageTier,
  pickBestAudioTtsTier,
  selectAvailableTiers,
  estimateFreedLlmVramMb,
  IMAGE_MODEL_TIERS,
  type LlmLoadParams,
} from "./model_orchestrator";
import { parseRocmVramUsedBytes } from "./vram_accounting";

const sampleParams: LlmLoadParams = {
  modelPath: "/tmp/model.gguf",
  gpuLayers: 32,
  contextSize: 8192,
};

describe("canTransition", () => {
  it("allows the spec'd happy-path transitions", () => {
    expect(canTransition("idle", "llm-loading")).toBe(true);
    expect(canTransition("llm-loading", "llm-loaded")).toBe(true);
    expect(canTransition("llm-loaded", "swapping-out")).toBe(true);
    expect(canTransition("swapping-out", "media-loading")).toBe(true);
    expect(canTransition("media-loading", "media-loaded")).toBe(true);
    expect(canTransition("media-loaded", "swapping-back")).toBe(true);
    expect(canTransition("swapping-back", "llm-loaded")).toBe(true);
  });

  it("allows any state to transition to idle on releaseAll-like paths", () => {
    expect(canTransition("llm-loading", "idle")).toBe(true);
    expect(canTransition("llm-loaded", "idle")).toBe(true);
    expect(canTransition("media-loading", "idle")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    expect(canTransition("idle", "media-loaded")).toBe(false);
    expect(canTransition("llm-loaded", "media-loaded")).toBe(false);
    expect(canTransition("media-loaded", "llm-loading")).toBe(false);
    expect(canTransition("swapping-back", "swapping-out")).toBe(false);
  });
});

describe("calculateOptimalLlmParams", () => {
  it("computes sane layer count for a 12GB GPU and a 7B model", () => {
    const out = calculateOptimalLlmParams({
      modelSizeGb: 4, // ~Q4 quant of 7B
      gpuVramMb: 12_000,
      totalGpuLayers: 32,
      desiredContextTokens: 8192,
    });
    expect(out.gpuLayers).toBeGreaterThan(0);
    expect(out.gpuLayers).toBeLessThanOrEqual(32);
    expect(out.contextSize).toBe(8192);
  });

  it("caps gpu layers at totalGpuLayers even when VRAM is abundant", () => {
    const out = calculateOptimalLlmParams({
      modelSizeGb: 1,
      gpuVramMb: 80_000,
      totalGpuLayers: 32,
    });
    expect(out.gpuLayers).toBe(32);
  });

  it("returns 0 layers when VRAM is below safety headroom", () => {
    const out = calculateOptimalLlmParams({
      modelSizeGb: 30,
      gpuVramMb: 256,
      totalGpuLayers: 64,
    });
    expect(out.gpuLayers).toBe(0);
  });

  it("defaults context size to 4096 when not specified", () => {
    const out = calculateOptimalLlmParams({
      modelSizeGb: 4,
      gpuVramMb: 12_000,
      totalGpuLayers: 32,
    });
    expect(out.contextSize).toBe(4096);
  });

  it("clamps context size to 512 minimum", () => {
    const out = calculateOptimalLlmParams({
      modelSizeGb: 4,
      gpuVramMb: 12_000,
      totalGpuLayers: 32,
      desiredContextTokens: 0,
    });
    expect(out.contextSize).toBeGreaterThanOrEqual(512);
  });
});

describe("ModelOrchestrator state machine", () => {
  let tmpFile: string;

  beforeEach(() => {
    _resetOrchestratorForTests();
    tmpFile = path.join(
      os.tmpdir(),
      `orch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
    );
  });

  afterEach(async () => {
    try {
      await fs.unlink(tmpFile);
    } catch {
      /* ignore */
    }
  });

  it("starts in idle state", () => {
    expect(getOrchestrator().getStatus().state).toBe("idle");
  });

  it("acquireLlm transitions idle → llm-loading → llm-loaded", async () => {
    const orch = getOrchestrator();
    const reloadHook = vi.fn().mockResolvedValue(undefined);
    orch.setHooks({ reloadLlm: reloadHook });
    await orch.acquireLlm(sampleParams);
    expect(orch.getStatus().state).toBe("llm-loaded");
    expect(orch.getStatus().currentLlmModel).toBe(sampleParams.modelPath);
    expect(reloadHook).toHaveBeenCalledOnce();
  });

  it("acquireLlm rolls back to idle when reloadLlm throws", async () => {
    const orch = getOrchestrator();
    orch.setHooks({
      reloadLlm: async () => {
        throw new Error("simulated load failure");
      },
    });
    await expect(orch.acquireLlm(sampleParams)).rejects.toThrow("simulated");
    expect(orch.getStatus().state).toBe("idle");
  });

  it("runMediaGeneration without prior acquireLlm throws", async () => {
    const orch = getOrchestrator();
    await expect(
      orch.runMediaGeneration({
        modelType: "image",
        prompt: "test",
        outputPath: tmpFile,
      }),
    ).rejects.toThrow();
  });

  it("runMediaGeneration full happy path drives state through swap and back", async () => {
    const orch = getOrchestrator();
    const states: string[] = [];
    const unload = vi.fn().mockImplementation(async () => {
      states.push(orch.getStatus().state);
    });
    const reload = vi.fn().mockImplementation(async () => {
      states.push(orch.getStatus().state);
    });
    orch.setHooks({ unloadLlm: unload, reloadLlm: reload });
    await orch.acquireLlm(sampleParams);
    states.length = 0; // discard the acquireLlm reload sample
    const result = await orch.runMediaGeneration({
      modelType: "image",
      prompt: "tiny",
      outputPath: tmpFile,
    });
    expect(result.success).toBe(true);
    expect(orch.getStatus().state).toBe("llm-loaded");
    // unload should have been called from swapping-out
    expect(states[0]).toBe("swapping-out");
    // reload should have been called from swapping-back
    expect(states[states.length - 1]).toBe("swapping-back");
    // Stub PNG must exist on disk
    const stat = await fs.stat(tmpFile);
    expect(stat.size).toBeGreaterThan(0);
  });

  it("releaseAll resets state to idle from any state", async () => {
    const orch = getOrchestrator();
    orch.setHooks({ reloadLlm: vi.fn().mockResolvedValue(undefined) });
    await orch.acquireLlm(sampleParams);
    expect(orch.getStatus().state).toBe("llm-loaded");
    await orch.releaseAll();
    expect(orch.getStatus().state).toBe("idle");
    expect(orch.getStatus().currentLlmModel).toBeNull();
  });

  it("mediaProvider hook replaces the stub when set", async () => {
    const orch = getOrchestrator();
    const provider = vi.fn().mockResolvedValue({
      success: true,
      outputPath: tmpFile,
      durationMs: 7,
    });
    orch.setHooks({
      reloadLlm: vi.fn().mockResolvedValue(undefined),
      mediaProvider: provider,
    });
    await orch.acquireLlm(sampleParams);
    const result = await orch.runMediaGeneration({
      modelType: "image",
      prompt: "tiny",
      outputPath: tmpFile,
    });
    expect(provider).toHaveBeenCalledOnce();
    expect(result.durationMs).toBe(7);
  });
});

describe("pickBestImageTier", () => {
  it("returns flux-schnell with 15 GB VRAM", () => {
    expect(pickBestImageTier(15000).id).toBe("flux-schnell");
  });

  it("returns sdxl-turbo with 9 GB VRAM", () => {
    expect(pickBestImageTier(9000).id).toBe("sdxl-turbo");
  });

  it("returns sd-1.5 with 5 GB VRAM", () => {
    expect(pickBestImageTier(5000).id).toBe("sd-1.5");
  });

  it("returns sd-1.5-cpu with 0 VRAM", () => {
    expect(pickBestImageTier(0).id).toBe("sd-1.5-cpu");
  });

  it("never returns a tier above preferredQuality", () => {
    // 15 GB VRAM is enough for flux-schnell but user wants 'good' max
    expect(pickBestImageTier(15000, "good").id).toBe("sdxl-turbo");
  });

  it("still returns floor tier when preferredQuality is set but VRAM is 0", () => {
    expect(pickBestImageTier(0, "good").id).toBe("sd-1.5-cpu");
  });

  it("orders tiers best to slow", () => {
    expect(IMAGE_MODEL_TIERS.map((t) => t.id)).toEqual([
      "flux-schnell",
      "sdxl-turbo",
      "sd-1.5",
      "sd-1.5-cpu",
    ]);
  });
});

describe("pickBestAudioTtsTier", () => {
  it("returns xtts-v2 with 4 GB VRAM", () => {
    expect(pickBestAudioTtsTier(4000).id).toBe("xtts-v2");
  });

  it("returns piper with 0 VRAM", () => {
    expect(pickBestAudioTtsTier(0).id).toBe("piper");
  });
});

describe("selectAvailableTiers", () => {
  it("combines live and freed VRAM when computing fitting tiers", () => {
    const snapshot = selectAvailableTiers(2000, 6000);
    // 2000 + 6000 = 8000 → sdxl-turbo fits
    expect(snapshot.projectedAvailableVramMb).toBe(8000);
    expect(snapshot.image[0].id).toBe("sdxl-turbo");
  });

  it("returns ALL fitting tiers in best-first order", () => {
    const snapshot = selectAvailableTiers(13000, 0);
    expect(snapshot.image.map((t) => t.id)).toEqual([
      "flux-schnell",
      "sdxl-turbo",
      "sd-1.5",
      "sd-1.5-cpu",
    ]);
  });
});

describe("estimateFreedLlmVramMb", () => {
  it("returns 0 when no LLM is loaded", () => {
    expect(estimateFreedLlmVramMb(null)).toBe(0);
  });

  it("returns ~gpuLayers × 250 MB", () => {
    expect(
      estimateFreedLlmVramMb({
        modelPath: "x",
        gpuLayers: 40,
        contextSize: 4096,
      }),
    ).toBe(10000);
  });
});

describe("parseRocmVramUsedBytes", () => {
  it("extracts byte count from a representative rocm-smi dump", () => {
    const sample = `
GPU[0]: VRAM Total Memory (B): 17163091968
GPU[0]: VRAM Total Used Memory (B): 1048576
    `;
    expect(parseRocmVramUsedBytes(sample)).toBe(1);
  });

  it("returns 0 when the marker is missing", () => {
    expect(parseRocmVramUsedBytes("nothing here")).toBe(0);
  });
});
