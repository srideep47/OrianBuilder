/**
 * Phase 4: hardware-aware LLM backend selection for node-llama-cpp.
 *
 * node-llama-cpp ships prebuilt binaries for CUDA, Metal, Vulkan, and CPU.
 * The correct backend is selected at model-load time based on which GPU the
 * user has — CUDA for Nvidia, Vulkan for AMD/Intel on Windows (auto-picked
 * by node-llama-cpp when CUDA is absent), Metal on Apple Silicon (auto on
 * macOS arm64), and CPU as the safe fallback.
 *
 * IMPORTANT — this module ONLY computes the options; it deliberately does
 * NOT wire them into the existing load path in embedded_inference_server.ts.
 * Rule #1: existing Nvidia/CUDA code paths must not be modified.
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
 * Returns node-llama-cpp options selecting the correct hardware backend for
 * this profile. The backend itself is auto-detected by node-llama-cpp at
 * load time — we just have to tell it whether to use GPU at all (via
 * gpuLayers > 0) and whether to memory-map (CPU only).
 *
 * AMD / Intel on Windows: node-llama-cpp's Vulkan prebuilt is selected
 * automatically when CUDA is unavailable. gpuLayers > 0 is sufficient.
 *
 * Apple Silicon (macOS arm64): Metal is the built-in default. gpuLayers > 0
 * triggers Metal offload automatically.
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
