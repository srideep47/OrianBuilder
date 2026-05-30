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
import {
  parseRocmVramUsedBytes,
  parseTypeperfGpuDedicatedMb,
} from "./vram_accounting";

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

  it("acquireLlm does not double-transition when reloadLlm self-advances state", async () => {
    // Regression: the embedded handler's loadModelFromConfig (wired as reloadLlm)
    // calls informLlmAcquired, advancing state to "llm-loaded" before acquireLlm's
    // own final transition. That used to throw "Invalid orchestrator transition:
    // llm-loaded -> llm-loaded". The guard must tolerate it.
    const orch = getOrchestrator();
    orch.setHooks({
      reloadLlm: async (params) => {
        orch.informLlmAcquired(params);
      },
    });
    await expect(orch.acquireLlm(sampleParams)).resolves.toBeUndefined();
    expect(orch.getStatus().state).toBe("llm-loaded");
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

  it("informLlmAcquired sets state to llm-loaded without invoking reloadLlm hook", () => {
    const orch = getOrchestrator();
    const reloadHook = vi.fn();
    orch.setHooks({ reloadLlm: reloadHook });
    orch.informLlmAcquired(sampleParams);
    expect(orch.getStatus().state).toBe("llm-loaded");
    expect(orch.getStatus().currentLlmModel).toBe(sampleParams.modelPath);
    expect(reloadHook).not.toHaveBeenCalled();
  });

  it("informLlmReleased resets to idle without invoking unloadLlm hook", () => {
    const orch = getOrchestrator();
    const unloadHook = vi.fn();
    orch.setHooks({ unloadLlm: unloadHook });
    orch.informLlmAcquired(sampleParams);
    orch.informLlmReleased();
    expect(orch.getStatus().state).toBe("idle");
    expect(orch.getStatus().currentLlmModel).toBeNull();
    expect(unloadHook).not.toHaveBeenCalled();
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
  it("returns z-image-turbo with 32 GB VRAM", () => {
    expect(pickBestImageTier(32000).id).toBe("z-image-turbo");
  });

  it("returns z-image-turbo with 12 GB VRAM", () => {
    expect(pickBestImageTier(12000).id).toBe("z-image-turbo");
  });

  it("returns z-image-turbo with 8 GB VRAM (auto-selected quality tier)", () => {
    expect(pickBestImageTier(8000).id).toBe("z-image-turbo");
  });

  it("returns sdxl-turbo with 6 GB VRAM", () => {
    expect(pickBestImageTier(6000).id).toBe("sdxl-turbo");
  });

  it("returns sdxl-turbo when only quality 'good' allowed at 8 GB", () => {
    expect(pickBestImageTier(8000, "good").id).toBe("sdxl-turbo");
  });

  it("returns sd-turbo with 4 GB VRAM (budget tier)", () => {
    expect(pickBestImageTier(4000).id).toBe("sd-turbo");
  });

  it("returns sd-1.5-onnx-cpu with 0 VRAM", () => {
    expect(pickBestImageTier(0).id).toBe("sd-1.5-onnx-cpu");
  });

  it("still returns floor tier when preferredQuality is set but VRAM is 0", () => {
    expect(pickBestImageTier(0, "good").id).toBe("sd-1.5-onnx-cpu");
  });

  it("orders tiers best → good → basic → slow (z-image-turbo before sdxl-turbo)", () => {
    expect(IMAGE_MODEL_TIERS.map((t) => t.id)).toEqual([
      "z-image-turbo",
      "sdxl-turbo",
      "sd-turbo",
      "sd-1.5",
      "sd-1.5-onnx-cpu",
    ]);
  });
});

describe("pickBestAudioTtsTier", () => {
  it("returns xtts-v2 with 4 GB VRAM (best tier that fits)", () => {
    expect(pickBestAudioTtsTier(4000).id).toBe("xtts-v2");
  });

  it("returns kokoro-82m with 1 GB VRAM", () => {
    expect(pickBestAudioTtsTier(1500).id).toBe("kokoro-82m");
  });

  it("returns piper with 0 VRAM", () => {
    expect(pickBestAudioTtsTier(0).id).toBe("piper");
  });
});

describe("selectAvailableTiers", () => {
  it("combines live and freed VRAM when computing fitting tiers", () => {
    const snapshot = selectAvailableTiers(2000, 6000);
    // 2000 + 6000 = 8000 → z-image-turbo fits (first in tier order at 8 GB)
    expect(snapshot.projectedAvailableVramMb).toBe(8000);
    expect(snapshot.image[0].id).toBe("z-image-turbo");
  });

  it("returns ALL fitting image tiers in best-first order at 13 GB", () => {
    const snapshot = selectAvailableTiers(13000, 0);
    expect(snapshot.image.map((t) => t.id)).toEqual([
      "z-image-turbo",
      "sdxl-turbo",
      "sd-turbo",
      "sd-1.5",
      "sd-1.5-onnx-cpu",
    ]);
  });

  it("includes the new audioStt tiers in the snapshot", () => {
    const snapshot = selectAvailableTiers(8000, 0);
    expect(snapshot.audioStt[0]?.id).toBe("whisper-large-v3-turbo");
  });
});

describe("estimateFreedLlmVramMb", () => {
  it("returns 0 when no LLM is loaded", () => {
    expect(estimateFreedLlmVramMb(null)).toBe(0);
  });

  it("returns 0 when gpuLayers <= 0 (CPU-only load)", () => {
    expect(
      estimateFreedLlmVramMb({
        modelPath: "x",
        gpuLayers: 0,
        contextSize: 4096,
      }),
    ).toBe(0);
  });

  it("falls back to gpuLayers × 250 MB when no geometry is supplied", () => {
    expect(
      estimateFreedLlmVramMb({
        modelPath: "x",
        gpuLayers: 40,
        contextSize: 4096,
      }),
    ).toBe(10000);
  });

  it("computes weights + KV from supplied geometry", () => {
    // 4 GB model, 32 layers, all offloaded, quantFactor=1
    //  weights = 4096 × 1 × (32/32) = 4096 MB
    //  KV      = 4096 × 4096 × 32 / (1024*1024) = 512 MB
    //  total   = 4608 MB
    const out = estimateFreedLlmVramMb({
      modelPath: "x",
      gpuLayers: 32,
      contextSize: 4096,
      modelSizeMb: 4096,
      totalLayers: 32,
      quantFactor: 1,
      kvBytesPerTokenPerLayer: 4096,
    });
    expect(out).toBe(4608);
  });

  it("scales weights proportionally to offloaded layers", () => {
    // Same as above but only half the layers on GPU
    //  weights = 4096 × 1 × (16/32) = 2048
    //  KV      = 4096 × 4096 × 16 / 1048576 = 256
    //  total   = 2304
    const out = estimateFreedLlmVramMb({
      modelPath: "x",
      gpuLayers: 16,
      contextSize: 4096,
      modelSizeMb: 4096,
      totalLayers: 32,
      quantFactor: 1,
      kvBytesPerTokenPerLayer: 4096,
    });
    expect(out).toBe(2304);
  });

  it("applies quantFactor when given (file-size based input)", () => {
    // 17 GB file, Q4_K_M (factor ≈ 0.82), 64 layers all offloaded, no KV info
    //  weights = 17408 × 0.82 × 1 = 14274.56 -> rounds to 14275
    const out = estimateFreedLlmVramMb({
      modelPath: "x",
      gpuLayers: 64,
      contextSize: 8192,
      modelSizeMb: 17408,
      totalLayers: 64,
      quantFactor: 0.82,
    });
    expect(out).toBe(14275);
  });

  it("defaults quantFactor to 0.85 when omitted but geometry is present", () => {
    const out = estimateFreedLlmVramMb({
      modelPath: "x",
      gpuLayers: 32,
      contextSize: 4096,
      modelSizeMb: 1000,
      totalLayers: 32,
    });
    // weights = 1000 × 0.85 × 1 = 850, no KV
    expect(out).toBe(850);
  });

  it("falls back when modelSizeMb is missing even if totalLayers present", () => {
    const out = estimateFreedLlmVramMb({
      modelPath: "x",
      gpuLayers: 10,
      contextSize: 4096,
      totalLayers: 32,
    });
    // Falls back to 10 × 250 = 2500
    expect(out).toBe(2500);
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

describe("parseTypeperfGpuDedicatedMb", () => {
  it("prefers the _Total counter when present", () => {
    const csv = [
      '"(PDH-CSV 4.0)","\\\\HOST\\GPU Adapter Memory(luid_0x...)\\Dedicated Usage","\\\\HOST\\GPU Adapter Memory(_Total)\\Dedicated Usage"',
      '"05/15/2026 12:00:00.000","2097152","8388608"',
    ].join("\n");
    // _Total = 8 MiB = 8 MB
    expect(parseTypeperfGpuDedicatedMb(csv)).toBe(8);
  });

  it("sums per-adapter values when no _Total is present", () => {
    const csv = [
      '"(PDH-CSV 4.0)","\\\\HOST\\GPU Adapter Memory(adapter1)\\Dedicated Usage","\\\\HOST\\GPU Adapter Memory(adapter2)\\Dedicated Usage"',
      '"05/15/2026 12:00:00.000","1048576","2097152"',
    ].join("\n");
    expect(parseTypeperfGpuDedicatedMb(csv)).toBe(3); // 1 MiB + 2 MiB
  });

  it("returns 0 when typeperf returned no samples", () => {
    expect(parseTypeperfGpuDedicatedMb("")).toBe(0);
    expect(parseTypeperfGpuDedicatedMb("garbage\nno quotes")).toBe(0);
  });
});
