import { describe, expect, it } from "vitest";
import {
  parseWmicGpuOutput,
  parseNvidiaSmiOutput,
  parseLspciVmm,
  selectPrimaryGpu,
  selectBestLlmBackend,
  selectBestMediaBackend,
} from "./detect";
import type { GpuInfo, HardwareProfile } from "./types";

describe("parseWmicGpuOutput", () => {
  it("parses a typical multi-GPU wmic CSV dump", () => {
    const csv = [
      "Node,AdapterRAM,Name",
      "HOST,4294967296,NVIDIA GeForce RTX 4090",
      "HOST,134217728,Intel(R) UHD Graphics 770",
    ].join("\r\n");
    const gpus = parseWmicGpuOutput(csv);
    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toMatchObject({
      vendor: "nvidia",
      model: "NVIDIA GeForce RTX 4090",
      vramMb: 4096,
      isIntegrated: false,
    });
    expect(gpus[1]).toMatchObject({
      vendor: "intel",
      vramMb: 128,
      isIntegrated: true,
    });
  });

  it("skips Microsoft Basic Display Adapter rows", () => {
    const csv = [
      "Node,AdapterRAM,Name",
      "HOST,0,Microsoft Basic Display Adapter",
      "HOST,8589934592,AMD Radeon RX 7900 XTX",
    ].join("\n");
    const gpus = parseWmicGpuOutput(csv);
    expect(gpus).toHaveLength(1);
    expect(gpus[0].vendor).toBe("amd");
    expect(gpus[0].vramMb).toBe(8192);
  });

  it("returns empty array on malformed input", () => {
    expect(parseWmicGpuOutput("")).toEqual([]);
    expect(parseWmicGpuOutput("junk\n")).toEqual([]);
  });
});

describe("parseNvidiaSmiOutput", () => {
  it("parses single-GPU output", () => {
    const csv = "NVIDIA GeForce RTX 4090, 24564 MiB";
    expect(parseNvidiaSmiOutput(csv)).toEqual([
      { model: "NVIDIA GeForce RTX 4090", vramMb: 24564 },
    ]);
  });

  it("parses multi-GPU output", () => {
    const csv = [
      "NVIDIA GeForce RTX 4090, 24564 MiB",
      "NVIDIA GeForce GTX 1080, 8192 MiB",
    ].join("\n");
    expect(parseNvidiaSmiOutput(csv)).toHaveLength(2);
  });

  it("returns empty array on empty input", () => {
    expect(parseNvidiaSmiOutput("")).toEqual([]);
  });
});

const nvidiaGpu: GpuInfo = {
  vendor: "nvidia",
  model: "RTX 4090",
  vramMb: 24564,
  isIntegrated: false,
};
const appleGpu: GpuInfo = {
  vendor: "apple",
  model: "Apple M3 Pro",
  vramMb: 0,
  isIntegrated: true,
};
const amdGpu: GpuInfo = {
  vendor: "amd",
  model: "Radeon RX 7900 XTX",
  vramMb: 24576,
  isIntegrated: false,
};
const intelDiscreteGpu: GpuInfo = {
  vendor: "intel",
  model: "Intel Arc A770",
  vramMb: 16384,
  isIntegrated: false,
};
const intelIntegrated: GpuInfo = {
  vendor: "intel",
  model: "Intel UHD 730",
  vramMb: 128,
  isIntegrated: true,
};

type BackendProfile = Pick<
  HardwareProfile,
  "primaryGpu" | "availableBackends" | "arch" | "os"
>;

describe("selectBestLlmBackend", () => {
  it("nvidia + cuda → cuda", () => {
    const p: BackendProfile = {
      primaryGpu: nvidiaGpu,
      availableBackends: ["cpu", "cuda"],
      arch: "x64",
      os: "windows",
    };
    expect(selectBestLlmBackend(p)).toBe("cuda");
  });

  it("apple arm64 + metal → metal", () => {
    const p: BackendProfile = {
      primaryGpu: appleGpu,
      availableBackends: ["cpu", "metal"],
      arch: "arm64",
      os: "macos",
    };
    expect(selectBestLlmBackend(p)).toBe("metal");
  });

  it("amd + rocm → rocm", () => {
    const p: BackendProfile = {
      primaryGpu: amdGpu,
      availableBackends: ["cpu", "rocm", "vulkan"],
      arch: "x64",
      os: "linux",
    };
    expect(selectBestLlmBackend(p)).toBe("rocm");
  });

  it("amd + windows + vulkan (no rocm) → vulkan", () => {
    const p: BackendProfile = {
      primaryGpu: amdGpu,
      availableBackends: ["cpu", "vulkan", "directml"],
      arch: "x64",
      os: "windows",
    };
    expect(selectBestLlmBackend(p)).toBe("vulkan");
  });

  it("no GPU → cpu", () => {
    const p: BackendProfile = {
      primaryGpu: null,
      availableBackends: ["cpu"],
      arch: "x64",
      os: "windows",
    };
    expect(selectBestLlmBackend(p)).toBe("cpu");
  });

  it("integrated-only GPU does not get vulkan path", () => {
    const p: BackendProfile = {
      primaryGpu: intelIntegrated,
      availableBackends: ["cpu", "vulkan", "directml"],
      arch: "x64",
      os: "windows",
    };
    expect(selectBestLlmBackend(p)).toBe("cpu");
  });
});

describe("selectBestMediaBackend", () => {
  it("nvidia + cuda → cuda", () => {
    expect(
      selectBestMediaBackend({
        primaryGpu: nvidiaGpu,
        availableBackends: ["cpu", "cuda"],
        arch: "x64",
        os: "windows",
      }),
    ).toBe("cuda");
  });

  it("apple arm64 + metal → metal (i.e. mps)", () => {
    expect(
      selectBestMediaBackend({
        primaryGpu: appleGpu,
        availableBackends: ["cpu", "metal"],
        arch: "arm64",
        os: "macos",
      }),
    ).toBe("metal");
  });

  it("amd + windows + directml → directml", () => {
    expect(
      selectBestMediaBackend({
        primaryGpu: amdGpu,
        availableBackends: ["cpu", "directml", "vulkan"],
        arch: "x64",
        os: "windows",
      }),
    ).toBe("directml");
  });

  it("amd + linux + rocm → rocm", () => {
    expect(
      selectBestMediaBackend({
        primaryGpu: amdGpu,
        availableBackends: ["cpu", "rocm"],
        arch: "x64",
        os: "linux",
      }),
    ).toBe("rocm");
  });

  it("intel discrete + openvino → openvino", () => {
    expect(
      selectBestMediaBackend({
        primaryGpu: intelDiscreteGpu,
        availableBackends: ["cpu", "openvino", "directml"],
        arch: "x64",
        os: "windows",
      }),
    ).toBe("openvino");
  });

  it("no GPU → cpu", () => {
    expect(
      selectBestMediaBackend({
        primaryGpu: null,
        availableBackends: ["cpu"],
        arch: "x64",
        os: "windows",
      }),
    ).toBe("cpu");
  });
});

describe("parseLspciVmm", () => {
  it("extracts an Nvidia + Intel pair from a representative lspci dump", () => {
    const stdout = `Slot:\t00:02.0
Class:\tVGA compatible controller [0300]
Vendor:\tIntel Corporation [8086]
Device:\tAlder Lake-S GT1 [UHD Graphics 770] [4680]
Rev:\t04

Slot:\t01:00.0
Class:\tVGA compatible controller [0300]
Vendor:\tNVIDIA Corporation [10de]
Device:\tAD102 [GeForce RTX 4090] [2684]
Rev:\ta1
`;
    const gpus = parseLspciVmm(stdout);
    expect(gpus).toHaveLength(2);
    expect(gpus[0].vendor).toBe("intel");
    expect(gpus[0].isIntegrated).toBe(true);
    expect(gpus[1].vendor).toBe("nvidia");
    expect(gpus[1].model).toContain("RTX 4090");
    expect(gpus[1].isIntegrated).toBe(false);
  });

  it("recognizes 3D controller class (datacenter GPUs)", () => {
    const stdout = `Slot:\t05:00.0
Class:\t3D controller [0302]
Vendor:\tNVIDIA Corporation [10de]
Device:\tGA100 [A100] [20b0]
`;
    expect(parseLspciVmm(stdout)).toHaveLength(1);
  });

  it("ignores non-display devices", () => {
    const stdout = `Slot:\t00:1f.6
Class:\tEthernet controller [0200]
Vendor:\tIntel Corporation [8086]
Device:\tEthernet Connection
`;
    expect(parseLspciVmm(stdout)).toEqual([]);
  });

  it("returns empty array on empty input", () => {
    expect(parseLspciVmm("")).toEqual([]);
  });
});

describe("selectPrimaryGpu (extended)", () => {
  it("prefers discrete over integrated even when integrated has more 'shared' VRAM", () => {
    const gpus: GpuInfo[] = [
      {
        vendor: "intel",
        model: "Iris Xe",
        vramMb: 4096,
        isIntegrated: true,
      },
      nvidiaGpu,
    ];
    expect(selectPrimaryGpu(gpus)?.vendor).toBe("nvidia");
  });
});
