import { describe, expect, it } from "vitest";
import { getRecommendedAgentContextSize } from "./embedded_model_allocation";

describe("embedded model allocation", () => {
  it("recommends 64K context for dense Qwen 3.6 27B on 16GB VRAM", () => {
    expect(
      getRecommendedAgentContextSize({
        fileName: "Qwen3.6-27B-Q4_K_M.gguf",
        architecture: "qwen35",
        contextLengthTrained: 262144,
        gpuBudgetMb: 16376 - 512,
        layerSizeMb: 203,
        totalLayers: 64,
        kvBytesPerTokenPerLayer: Math.round(2 * 4 * (5120 / 24) * 2),
        flashAttention: true,
      }),
    ).toBe(65536);
  });

  it("recommends 128K context for Qwen 3.6 35B-A3B MoE on 16GB VRAM", () => {
    expect(
      getRecommendedAgentContextSize({
        fileName: "Qwen3.6-35B-A3B-Q4_K_M.gguf",
        architecture: "qwen35moe",
        contextLengthTrained: 262144,
        gpuBudgetMb: 16376 - 512,
        layerSizeMb: 414,
        totalLayers: 40,
        kvBytesPerTokenPerLayer: 1024,
        flashAttention: true,
      }),
    ).toBe(131072);
  });
});
