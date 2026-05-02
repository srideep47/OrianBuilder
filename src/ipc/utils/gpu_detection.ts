import { execFile } from "node:child_process";
import { promisify } from "node:util";
import log from "electron-log";

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
  // Reserve ~1.5 GB for KV cache and OS
  const usableVramMb = vramMb - 1536;
  if (usableVramMb <= 0) return 0;
  const fraction = usableVramMb / modelSizeMb;
  // Each transformer layer is roughly equal in size; 64 total for 27B models
  const totalLayers = 64;
  return Math.min(totalLayers, Math.floor(fraction * totalLayers));
}

export async function detectGpu(modelSizeMb = 17920): Promise<GpuInfo> {
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
    const recommendedGpuLayers = recommendGpuLayers(vramMb, modelSizeMb);

    logger.info(
      `GPU detected: ${name}, ${vramMb} MB VRAM, CC ${ccStr}, tensor cores: ${hasTensorCores}`,
    );

    return {
      available: true,
      name,
      vramMb,
      computeCapability,
      hasTensorCores,
      tensorCoreGen,
      recommendedGpuLayers,
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
    };
  }
}
