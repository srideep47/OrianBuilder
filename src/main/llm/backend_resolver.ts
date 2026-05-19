/**
 * Hardware-aware LLM backend selection for the llama-server child process.
 *
 * llama.cpp ships prebuilt llama-server variants for CUDA, Metal, Vulkan, and
 * CPU; `llama_server_binary.ts::pickLlamaServerVariant` chooses which binary
 * to spawn from a hardware profile. This module owns the secondary decision:
 * given a chosen variant, how many layers should be offloaded to the GPU and
 * should mmap be enabled. CPU-only systems get `gpuLayers=0, useMmap=true`;
 * any system with a usable GPU gets `gpuLayers=-1, useMmap=false` ("all
 * layers on GPU" until the caller computes a precise count for the model).
 */

import type { HardwareProfile } from "@/main/hardware/types";

export interface LlmBackendOptions {
  /** Number of model layers to offload to GPU. `-1` = "all layers"; consumers
   *  that want an exact count should call calculateOptimalLlmParams. */
  gpuLayers: number;
  /** Memory-map the model file. Cheap when we plan to run from CPU memory
   *  (CPU backend); avoided when GPU-offloading because mmap doesn't help and
   *  can fight the GPU loader on some systems. */
  useMmap: boolean;
}

/**
 * Returns llama-server options selecting the correct hardware backend for
 * this profile. The actual backend (CUDA/Vulkan/Metal/CPU) is encoded by the
 * binary variant we pick — here we just decide whether to use the GPU at all
 * (via gpuLayers > 0) and whether to memory-map the model file (CPU only).
 *
 * AMD / Intel on Windows: the win-vulkan variant runs on top of Vulkan and
 * accepts gpuLayers > 0 the same way as CUDA does.
 *
 * Apple Silicon (macOS arm64): the mac-metal variant maps GPU layers to
 * Metal automatically; gpuLayers > 0 triggers offload.
 *
 * CPU-only: gpuLayers = 0, useMmap = true.
 */
export function resolveLlmBackendOptions(
  profile: HardwareProfile,
): LlmBackendOptions {
  if (profile.bestLlmBackend === "cpu") {
    return { gpuLayers: 0, useMmap: true };
  }
  // -1 is the sentinel for "all layers on GPU" — callers can replace it with
  // an exact count from calculateOptimalLlmParams once they know the model's
  // total layer count.
  return { gpuLayers: -1, useMmap: false };
}

/**
 * Returns a human-readable label for the current LLM backend, e.g.
 *   "CUDA (NVIDIA GeForce RTX 4090)"
 *   "Metal (Apple M3 Pro)"
 *   "Vulkan (AMD Radeon RX 7900 XTX)"
 *   "CPU (Intel(R) Core(TM) i9-13900K)"
 */
export function getLlmBackendName(profile: HardwareProfile): string {
  const backend = profile.bestLlmBackend;
  const gpu = profile.primaryGpu;
  const fallbackHardware = gpu?.model ?? profile.cpu.model;
  switch (backend) {
    case "cuda":
      return `CUDA (${gpu?.model ?? "Nvidia GPU"})`;
    case "rocm":
      return `ROCm (${gpu?.model ?? "AMD GPU"})`;
    case "metal":
      return `Metal (${gpu?.model ?? profile.cpu.model})`;
    case "vulkan":
      return `Vulkan (${gpu?.model ?? "GPU"})`;
    case "cpu":
      return `CPU (${profile.cpu.model})`;
    default:
      return `${(backend as string).toUpperCase()} (${fallbackHardware})`;
  }
}
