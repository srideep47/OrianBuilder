import { describe, expect, it } from "vitest";
import {
  buildLlamaServerArgs,
  resolveSafeRuntimeContextSize,
} from "./llama_server_args";

function baseInput() {
  return {
    modelPath: "D:/models/model.gguf",
    host: "127.0.0.1",
    port: 11435,
    contextSize: 65_536,
    gpuLayersMode: "manual" as const,
    manualGpuLayers: 24,
  };
}

describe("buildLlamaServerArgs memory limits", () => {
  it("defaults to one slot and a 256 MiB prompt cache", () => {
    const { flags } = buildLlamaServerArgs(baseInput());
    const parallelIndex = flags.indexOf("--parallel");
    const cacheIndex = flags.indexOf("--cache-ram");

    expect(flags[parallelIndex + 1]).toBe("1");
    expect(flags[cacheIndex + 1]).toBe("256");
  });

  it("accepts explicit bounded server concurrency and cache values", () => {
    const { flags } = buildLlamaServerArgs({
      ...baseInput(),
      parallelSlots: 2,
      promptCacheMb: 256,
    });
    const parallelIndex = flags.indexOf("--parallel");
    const cacheIndex = flags.indexOf("--cache-ram");

    expect(flags[parallelIndex + 1]).toBe("2");
    expect(flags[cacheIndex + 1]).toBe("256");
  });
});

describe("resolveSafeRuntimeContextSize", () => {
  const gib = 1024 ** 3;

  it("caps a large vision model at 48k on a 64 GiB workstation", () => {
    expect(
      resolveSafeRuntimeContextSize({
        requestedContextSize: 131_072,
        modelSizeBytes: 20 * gib,
        totalMemoryBytes: 64 * gib,
        freeMemoryBytes: 40 * gib,
        hasMultimodalProjector: true,
      }),
    ).toBe(49_152);
  });

  it("uses 32k when a large model is started under memory pressure", () => {
    expect(
      resolveSafeRuntimeContextSize({
        requestedContextSize: 131_072,
        modelSizeBytes: 20 * gib,
        totalMemoryBytes: 64 * gib,
        freeMemoryBytes: 12 * gib,
        hasMultimodalProjector: true,
      }),
    ).toBe(32_768);
  });

  it("does not restrict a small model or an explicit short context", () => {
    expect(
      resolveSafeRuntimeContextSize({
        requestedContextSize: 131_072,
        modelSizeBytes: 8 * gib,
        totalMemoryBytes: 64 * gib,
        freeMemoryBytes: 40 * gib,
        hasMultimodalProjector: false,
      }),
    ).toBe(131_072);
    expect(
      resolveSafeRuntimeContextSize({
        requestedContextSize: 32_768,
        modelSizeBytes: 20 * gib,
        totalMemoryBytes: 64 * gib,
        freeMemoryBytes: 12 * gib,
        hasMultimodalProjector: true,
      }),
    ).toBe(32_768);
  });
});
