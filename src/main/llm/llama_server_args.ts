/**
 * Translates the orchestrator's `EmbeddedModelConfig` into llama-server CLI
 * flags. Kept pure so it's easy to unit-test the mapping.
 *
 * Reference: https://github.com/ggerganov/llama.cpp/tree/master/examples/server
 */

import {
  calculateGpuLayers,
  clampGpuLayers,
} from "@/ipc/utils/inference/gpu_layer_calc";

export interface LlamaServerArgInput {
  modelPath: string;
  /** Optional path to a multimodal projector (`mmproj-*.gguf`) sitting next
   *  to the main model. Required for vision-capable models like Qwen3-VL,
   *  Qwen3.6-VL, LLaVA, etc. — without it llama.cpp rejects image inputs
   *  with HTTP 500 "image input is not supported". */
  mmprojPath?: string | null;
  host: string;
  port: number;
  contextSize: number;
  batchSize?: number;
  flashAttention?: boolean;
  /** Number of CPU threads. Defaults to logical core count - 1. */
  threads?: number;
  /** When the profile is CPU-only, this is forced to 0 by the caller. */
  gpuLayersMode?: "auto" | "manual";
  manualGpuLayers?: number | null;
  /** Auto-mode inputs (already computed by the orchestrator). */
  autoCompute?: {
    vramMb: number;
    gpuMemoryUtilization: number;
    vramHeadroomMb?: number;
    layerSizeMb: number;
    totalLayers: number;
    kvBytesPerTokenPerLayer: number;
    attentionSlidingWindow?: number | null;
    attentionSlidingWindowPattern?: number | null;
    /** Estimated VRAM consumed by the multimodal projector (mmproj). When set,
     *  the layer calculator subtracts this from the available budget so the
     *  resolved n_gpu_layers leaves room for the projector. */
    mmprojOverheadMb?: number;
  };
  /** Optional Jinja chat template override (relative to model's GGUF metadata default). */
  chatTemplate?: string | null;
  /** Enable Jinja-based tool calling. llama-server supports OpenAI tool format
   *  natively when --jinja is set and the model's template handles tool roles. */
  enableJinjaTools?: boolean;
  /** Quantization for KV cache (e.g., "q8_0" reduces VRAM at small quality cost). */
  cacheTypeK?: string;
  cacheTypeV?: string;
  /** Force-disable mmap (rarely needed). */
  noMmap?: boolean;
  /** Mlock model into RAM (Linux/macOS; ignored on Windows). */
  mlock?: boolean;
  /**
   * Vulkan/ROCm device selection hint. Passed as `--device <overrideDevice>` to
   * llama-server so the correct physical device is chosen when multiple Vulkan
   * devices are present (e.g. NVIDIA + AMD iGPU on the same system).
   * llama.cpp accepts a partial name like "AMD", "Intel", or the full device
   * name. Leave undefined when using CUDA (device selection is handled by
   * CUDA_VISIBLE_DEVICES or driver default).
   */
  overrideDevice?: string;
}

export interface LlamaServerArgs {
  flags: string[];
  /** Resolved GPU layer count — exposed so we can report it via status. */
  resolvedGpuLayers: number;
}

export function buildLlamaServerArgs(
  input: LlamaServerArgInput,
): LlamaServerArgs {
  const flags: string[] = [];
  flags.push("--model", input.modelPath);
  if (input.mmprojPath) {
    flags.push("--mmproj", input.mmprojPath);
  }
  flags.push("--host", input.host);
  flags.push("--port", String(input.port));
  flags.push("--ctx-size", String(input.contextSize));

  if (input.batchSize && input.batchSize > 0) {
    flags.push("--batch-size", String(input.batchSize));
  }

  // Newer llama-server builds require --flash-attn to take an explicit
  // value (on|off|auto); the bare flag would consume the next CLI token.
  if (input.flashAttention === true) {
    flags.push("--flash-attn", "on");
  } else if (input.flashAttention === false) {
    flags.push("--flash-attn", "off");
  }

  if (typeof input.threads === "number" && input.threads > 0) {
    flags.push("--threads", String(input.threads));
  }

  // Resolve GPU layer count.
  const resolvedGpuLayers = resolveGpuLayers(input);
  flags.push("--n-gpu-layers", String(resolvedGpuLayers));

  if (input.cacheTypeK) {
    flags.push("--cache-type-k", input.cacheTypeK);
  }
  if (input.cacheTypeV) {
    flags.push("--cache-type-v", input.cacheTypeV);
  }

  if (input.noMmap) {
    flags.push("--no-mmap");
  }
  if (input.mlock) {
    flags.push("--mlock");
  }

  if (input.enableJinjaTools) {
    flags.push("--jinja");
  }

  if (input.chatTemplate) {
    flags.push("--chat-template", input.chatTemplate);
  }

  if (input.overrideDevice) {
    flags.push("--device", input.overrideDevice);
  }

  return { flags, resolvedGpuLayers };
}

function resolveGpuLayers(input: LlamaServerArgInput): number {
  if (
    input.gpuLayersMode === "manual" &&
    typeof input.manualGpuLayers === "number"
  ) {
    const totalLayers = input.autoCompute?.totalLayers ?? 64;
    return clampGpuLayers(input.manualGpuLayers, totalLayers);
  }
  if (!input.autoCompute) {
    // No info to compute — let llama-server decide (`-1` = all layers).
    return -1;
  }
  const auto = input.autoCompute;
  return calculateGpuLayers(
    auto.vramMb,
    auto.gpuMemoryUtilization,
    auto.vramHeadroomMb,
    auto.layerSizeMb,
    auto.totalLayers,
    input.contextSize,
    auto.kvBytesPerTokenPerLayer,
    auto.attentionSlidingWindow,
    auto.attentionSlidingWindowPattern,
    !!input.flashAttention,
    auto.mmprojOverheadMb,
  );
}
