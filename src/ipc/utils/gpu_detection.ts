import { execFile } from "node:child_process";
import { promisify } from "node:util";
import log from "electron-log";
import {
  getCachedHardwareProfile,
  selectBestLlmBackend,
} from "@/main/hardware/detect";
import type { AllGpusInfo } from "@/ipc/types/embedded_model";

const execFileAsync = promisify(execFile);
const logger = log.scope("gpu_detection");

export interface GpuInfo {
  available: boolean;
  name: string;
  vramMb: number;
  computeCapability: number;
  hasTensorCores: boolean;
  tensorCoreGen: string;
  recommendedGpuLayers: number;
  vendor?: "nvidia" | "amd" | "intel" | "apple" | "unknown";
  isIntegrated?: boolean;
  backend?: "cuda" | "vulkan" | "rocm" | "metal" | "cpu";
}

const TENSOR_CORE_GENS: Record<string, string> = {
  "7.0": "Volta",
  "7.5": "Turing",
  "8.0": "Ampere",
  "8.6": "Ampere",
  "8.7": "Ampere",
  "8.9": "Ada Lovelace",
  "9.0": "Hopper",
};

function getTensorCoreGen(cc: number): string {
  const key = cc.toFixed(1);
  return (
    TENSOR_CORE_GENS[key] ?? (cc >= 7.0 ? "Unknown (Tensor Cores)" : "None")
  );
}

function recommendGpuLayers(vramMb: number, modelSizeMb: number): number {
  const usableVramMb = vramMb - 1536;
  if (usableVramMb <= 0) return 0;
  const fraction = usableVramMb / modelSizeMb;
  const totalLayers = 64;
  return Math.min(totalLayers, Math.floor(fraction * totalLayers));
}

/**
 * Returns GPU info for the active/selected GPU.
 *
 * If `selectedGpuModel` is provided, looks up that GPU in the hardware profile
 * (for AMD/Intel VRAM) and falls through to nvidia-smi only for NVIDIA GPUs.
 * Falls back gracefully to CPU-only if nothing is found.
 */
export async function detectGpu(
  modelSizeMb = 17920,
  selectedGpuModel?: string,
): Promise<GpuInfo> {
  // Try hardware profile first — covers AMD, Intel, and NVIDIA VRAM.
  try {
    const profile = await getCachedHardwareProfile();

    let targetGpu = selectedGpuModel
      ? (profile.gpus.find((g) => g.model === selectedGpuModel) ?? null)
      : profile.primaryGpu;

    if (targetGpu) {
      const backend = selectBestLlmBackend({
        primaryGpu: targetGpu,
        availableBackends: profile.availableBackends,
        arch: profile.arch,
      });

      // For NVIDIA, overlay compute capability from nvidia-smi when available.
      let computeCapability = 0;
      let hasTensorCores = false;
      let tensorCoreGen = "None";
      if (targetGpu.vendor === "nvidia") {
        try {
          const { stdout } = await execFileAsync("nvidia-smi", [
            "--query-gpu=name,memory.total,compute_cap",
            "--format=csv,noheader,nounits",
          ]);
          const line = stdout.trim().split("\n")[0];
          if (line) {
            const parts = line.split(",").map((s) => s.trim());
            const ccStr = parts[2];
            computeCapability = parseFloat(ccStr);
            hasTensorCores = computeCapability >= 7.0;
            tensorCoreGen = getTensorCoreGen(computeCapability);
            // nvidia-smi VRAM is more accurate than WMI — override if available
            const nvVram = parseInt(parts[1], 10);
            if (!isNaN(nvVram) && nvVram > 0)
              targetGpu = { ...targetGpu, vramMb: nvVram };
          }
        } catch {
          /* nvidia-smi not available — keep WMI values */
        }
      }

      return {
        available: true,
        name: targetGpu.model,
        vramMb: targetGpu.vramMb,
        computeCapability,
        hasTensorCores,
        tensorCoreGen,
        recommendedGpuLayers: recommendGpuLayers(targetGpu.vramMb, modelSizeMb),
        vendor: targetGpu.vendor,
        isIntegrated: targetGpu.isIntegrated,
        backend,
      };
    }
  } catch (err) {
    logger.warn("Hardware profile GPU detection failed:", err);
  }

  // Legacy fallback: nvidia-smi only (original behaviour)
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=name,memory.total,compute_cap",
      "--format=csv,noheader,nounits",
    ]);

    const line = stdout.trim().split("\n")[0];
    if (!line) throw new Error("No GPU found");

    const parts = line.split(",").map((s) => s.trim());
    const name = parts[0];
    const vramMb = parseInt(parts[1], 10);
    const ccStr = parts[2];
    const computeCapability = parseFloat(ccStr);
    const hasTensorCores = computeCapability >= 7.0;
    const tensorCoreGen = getTensorCoreGen(computeCapability);

    logger.info(
      `GPU detected (nvidia-smi): ${name}, ${vramMb} MB VRAM, CC ${ccStr}`,
    );

    return {
      available: true,
      name,
      vramMb,
      computeCapability,
      hasTensorCores,
      tensorCoreGen,
      recommendedGpuLayers: recommendGpuLayers(vramMb, modelSizeMb),
      vendor: "nvidia",
      isIntegrated: false,
      backend: "cuda",
    };
  } catch (err) {
    logger.warn("nvidia-smi not available or failed:", err);
    return {
      available: false,
      name: "CPU only",
      vramMb: 0,
      computeCapability: 0,
      hasTensorCores: false,
      tensorCoreGen: "None",
      recommendedGpuLayers: 0,
      vendor: "unknown",
      isIntegrated: false,
      backend: "cpu",
    };
  }
}

/** Returns all detected GPUs with their per-GPU best backend. */
export async function detectAllGpus(): Promise<AllGpusInfo> {
  try {
    const profile = await getCachedHardwareProfile();
    const gpus = profile.gpus.map((gpu) => ({
      model: gpu.model,
      vendor: gpu.vendor,
      vramMb: gpu.vramMb,
      isIntegrated: gpu.isIntegrated,
      bestBackend: selectBestLlmBackend({
        primaryGpu: gpu,
        availableBackends: profile.availableBackends,
        arch: profile.arch,
      }),
    }));

    const primaryModel = profile.primaryGpu?.model;
    const autoPrimaryIndex = Math.max(
      0,
      gpus.findIndex((g) => g.model === primaryModel),
    );

    return { gpus, autoPrimaryIndex };
  } catch (err) {
    logger.warn("detectAllGpus failed:", err);
    return { gpus: [], autoPrimaryIndex: 0 };
  }
}
