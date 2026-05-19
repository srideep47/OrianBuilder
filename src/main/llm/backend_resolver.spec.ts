import { describe, expect, it } from "vitest";
import {
  resolveLlmBackendOptions,
  getLlmBackendName,
} from "./backend_resolver";
import type { HardwareProfile } from "@/main/hardware/types";

function makeProfile(overrides: Partial<HardwareProfile>): HardwareProfile {
  return {
    os: "windows",
    arch: "x64",
    cpu: {
      vendor: "intel",
      model: "Intel(R) Core(TM) i9-13900K",
      cores: 24,
      logicalCores: 32,
    },
    gpus: [],
    primaryGpu: null,
    totalRamMb: 32_768,
    availableBackends: ["cpu"],
    bestLlmBackend: "cpu",
    bestMediaBackend: "cpu",
    ...overrides,
  };
}

describe("resolveLlmBackendOptions", () => {
  it("returns gpuLayers > 0 (-1 sentinel) when GPU is desired", () => {
    const profile = makeProfile({
      bestLlmBackend: "cuda",
      primaryGpu: {
        vendor: "nvidia",
        model: "RTX 4090",
        vramMb: 24576,
        isIntegrated: false,
      },
    });
    const opts = resolveLlmBackendOptions(profile);
    expect(opts.gpuLayers).not.toBe(0);
    expect(opts.useMmap).toBe(false);
  });

  it("returns gpuLayers === 0 + useMmap=true when CPU only", () => {
    const profile = makeProfile({ bestLlmBackend: "cpu" });
    const opts = resolveLlmBackendOptions(profile);
    expect(opts.gpuLayers).toBe(0);
    expect(opts.useMmap).toBe(true);
  });

  it("Vulkan backend also opts into GPU offload", () => {
    const profile = makeProfile({
      bestLlmBackend: "vulkan",
      primaryGpu: {
        vendor: "amd",
        model: "RX 7900 XTX",
        vramMb: 24576,
        isIntegrated: false,
      },
    });
    expect(resolveLlmBackendOptions(profile).gpuLayers).not.toBe(0);
  });

  it("Metal backend also opts into GPU offload", () => {
    const profile = makeProfile({
      os: "macos",
      arch: "arm64",
      bestLlmBackend: "metal",
      primaryGpu: {
        vendor: "apple",
        model: "Apple M3 Pro",
        vramMb: 0,
        isIntegrated: true,
      },
    });
    expect(resolveLlmBackendOptions(profile).gpuLayers).not.toBe(0);
  });
});

describe("getLlmBackendName", () => {
  it("formats Nvidia/CUDA", () => {
    const name = getLlmBackendName(
      makeProfile({
        bestLlmBackend: "cuda",
        primaryGpu: {
          vendor: "nvidia",
          model: "NVIDIA GeForce RTX 4090",
          vramMb: 24576,
          isIntegrated: false,
        },
      }),
    );
    expect(name).toContain("CUDA");
    expect(name).toContain("RTX 4090");
  });

  it("formats AMD/ROCm", () => {
    const name = getLlmBackendName(
      makeProfile({
        bestLlmBackend: "rocm",
        primaryGpu: {
          vendor: "amd",
          model: "Radeon RX 7900 XTX",
          vramMb: 24576,
          isIntegrated: false,
        },
      }),
    );
    expect(name).toContain("ROCm");
  });

  it("formats Vulkan", () => {
    const name = getLlmBackendName(
      makeProfile({
        bestLlmBackend: "vulkan",
        primaryGpu: {
          vendor: "amd",
          model: "RX 6800 XT",
          vramMb: 16384,
          isIntegrated: false,
        },
      }),
    );
    expect(name).toContain("Vulkan");
  });

  it("formats Apple Metal", () => {
    const name = getLlmBackendName(
      makeProfile({
        os: "macos",
        arch: "arm64",
        bestLlmBackend: "metal",
        primaryGpu: {
          vendor: "apple",
          model: "Apple M3 Pro",
          vramMb: 0,
          isIntegrated: true,
        },
      }),
    );
    expect(name).toContain("Metal");
  });

  it("formats CPU fallback", () => {
    const name = getLlmBackendName(makeProfile({ bestLlmBackend: "cpu" }));
    expect(name).toContain("CPU");
    expect(name).toContain("i9-13900K");
  });
});
