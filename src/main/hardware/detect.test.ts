import { describe, expect, it } from "vitest";
import {
  detectGpuVendor,
  detectIsIntegrated,
  selectPrimaryGpu,
} from "./detect";
import type { GpuInfo } from "./types";

describe("detectGpuVendor", () => {
  it.each([
    ["NVIDIA GeForce RTX 4090", "nvidia"],
    ["NVIDIA GeForce GTX 1060", "nvidia"],
    ["Quadro P4000", "nvidia"],
    ["AMD Radeon RX 7900 XTX", "amd"],
    ["AMD Radeon RX Vega 56", "amd"],
    ["AMD Radeon Graphics", "amd"],
    ["Intel(R) UHD Graphics 630", "intel"],
    ["Intel(R) Arc A770 Graphics", "intel"],
    ["Intel(R) Iris Xe Graphics", "intel"],
    ["Apple M3 Pro", "apple"],
    ["VirtualBox Graphics Adapter", "unknown"],
  ] as [string, string][])(
    'detectGpuVendor("%s") === "%s"',
    (name, expected) => {
      expect(detectGpuVendor(name)).toBe(expected);
    },
  );
});

describe("detectIsIntegrated", () => {
  it.each([
    ["Intel(R) UHD Graphics 630", "intel", true],
    ["Intel(R) HD Graphics 4600", "intel", true],
    ["Intel(R) Iris Xe Graphics", "intel", true],
    ["Intel(R) Arc A770 Graphics", "intel", false],
    ["AMD Radeon RX 7900 XTX", "amd", false],
    ["AMD Radeon Graphics", "amd", true],
    ["AMD Radeon Vega 8", "amd", true],
    ["AMD Radeon RX Vega 56", "amd", false],
    ["NVIDIA GeForce RTX 4090", "nvidia", false],
    ["Apple M3 Pro", "apple", true],
  ] as [string, GpuInfo["vendor"], boolean][])(
    'detectIsIntegrated("%s", "%s") === %s',
    (name, vendor, expected) => {
      expect(detectIsIntegrated(name, vendor)).toBe(expected);
    },
  );
});

describe("selectPrimaryGpu", () => {
  it("returns null for empty array", () => {
    expect(selectPrimaryGpu([])).toBeNull();
  });

  it("picks highest-VRAM discrete GPU", () => {
    const gpus: GpuInfo[] = [
      {
        vendor: "nvidia",
        model: "RTX 4090",
        vramMb: 24576,
        isIntegrated: false,
      },
      {
        vendor: "nvidia",
        model: "RTX 3060",
        vramMb: 12288,
        isIntegrated: false,
      },
      { vendor: "intel", model: "UHD 630", vramMb: 128, isIntegrated: true },
    ];
    expect(selectPrimaryGpu(gpus)?.model).toBe("RTX 4090");
  });

  it("ignores integrated GPUs when discrete are present", () => {
    const gpus: GpuInfo[] = [
      { vendor: "intel", model: "UHD 730", vramMb: 256, isIntegrated: true },
      {
        vendor: "nvidia",
        model: "RTX 3080",
        vramMb: 10240,
        isIntegrated: false,
      },
    ];
    expect(selectPrimaryGpu(gpus)?.model).toBe("RTX 3080");
  });

  it("falls back to integrated when no discrete GPU exists", () => {
    const gpus: GpuInfo[] = [
      { vendor: "intel", model: "UHD 730", vramMb: 256, isIntegrated: true },
    ];
    expect(selectPrimaryGpu(gpus)?.model).toBe("UHD 730");
  });

  it("returns single GPU regardless of type", () => {
    const gpus: GpuInfo[] = [
      { vendor: "apple", model: "Apple M3 Pro", vramMb: 0, isIntegrated: true },
    ];
    expect(selectPrimaryGpu(gpus)?.model).toBe("Apple M3 Pro");
  });

  it("picks GPU with most VRAM when all are integrated", () => {
    const gpus: GpuInfo[] = [
      { vendor: "intel", model: "UHD 630", vramMb: 128, isIntegrated: true },
      { vendor: "intel", model: "Iris Xe", vramMb: 512, isIntegrated: true },
    ];
    expect(selectPrimaryGpu(gpus)?.model).toBe("Iris Xe");
  });
});
