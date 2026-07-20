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
  /** Concurrent inference slots. One slot is the safe default for a desktop
   *  app: extra slots duplicate context working sets and are unnecessary while
   *  the UI serializes local generations. */
  parallelSlots?: number;
  /** Upper bound for llama-server's saved prompt checkpoints in system RAM.
   *  This is separate from the live KV cache. */
  promptCacheMb?: number;
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

/**
 * The configured context is an upper bound, not a promise that it is safe to
 * allocate on every machine.  Long contexts have a substantial *system RAM*
 * cost even when the model weights and most layers fit in VRAM: llama-server's
 * live KV cache, prompt checkpoints, the multimodal projector, and Electron
 * all coexist in the same process set.
 *
 * Keep large (12 GiB+) GGUFs on a 64 GiB-or-smaller workstation within a
 * 48k-token working window.  This comfortably supports the agent's project
 * context while preventing the unbounded 131k setting from evicting the
 * renderer.  When the machine is already under pressure, use 32k instead.
 * The saved user preference is intentionally left untouched; this only
 * resolves the safe runtime value for this launch.
 */
export function resolveSafeRuntimeContextSize(input: {
  requestedContextSize: number;
  modelSizeBytes: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  hasMultimodalProjector: boolean;
}): number {
  const requested = Math.max(2_048, Math.floor(input.requestedContextSize));
  const gib = 1024 ** 3;
  const isLargeModel = input.modelSizeBytes >= 12 * gib;
  const isConstrainedWorkstation = input.totalMemoryBytes <= 72 * gib;

  if (!isLargeModel || !isConstrainedWorkstation || requested <= 32_768) {
    return requested;
  }

  // A vision projector adds another large native allocation.  It is a useful
  // signal for logging, while the model/RAM limits above remain the actual
  // safety boundary for text-only large models too.
  const normalCap = input.hasMultimodalProjector ? 49_152 : 57_344;
  const lowMemoryCap = 32_768;
  const safeCap = input.freeMemoryBytes < 14 * gib ? lowMemoryCap : normalCap;
  return Math.min(requested, safeCap);
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
  // Guard: NaN/Infinity can reach here if GGUF metadata is missing or uses
  // keys the reader doesn't recognise (e.g. newly-released model families like
  // Gemma 4). Newer llama-server also rejects -1 and requires "all" instead.
  const gpuLayersArg =
    !Number.isFinite(resolvedGpuLayers) || resolvedGpuLayers < 0
      ? "all"
      : String(Math.floor(resolvedGpuLayers));
  flags.push("--n-gpu-layers", gpuLayersArg);

  if (input.cacheTypeK) {
    flags.push("--cache-type-k", input.cacheTypeK);
  }
  if (input.cacheTypeV) {
    flags.push("--cache-type-v", input.cacheTypeV);
  }

  // llama-server otherwise auto-selects four slots and an 8 GiB prompt cache.
  // Those defaults are intended for a shared server, not a single-user
  // Electron app, and were enough to exhaust a 64 GiB workstation during a
  // long agent session. Keep one request slot and a bounded checkpoint cache;
  // both can be overridden explicitly by a future advanced setting.
  const parallelSlots = Math.max(1, Math.floor(input.parallelSlots ?? 1));
  // Prompt checkpoints duplicate portions of the live context in system RAM.
  // 256 MiB is enough to speed up short retries without allowing a long agent
  // session to reserve multiple gigabytes of duplicate KV state.
  const promptCacheMb = Math.max(0, Math.floor(input.promptCacheMb ?? 256));
  flags.push("--parallel", String(parallelSlots));
  flags.push("--cache-ram", String(promptCacheMb));

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

  // Normalise for status reporting: NaN → -1, negative → -1 (means "all")
  const safeResolvedGpuLayers =
    Number.isFinite(resolvedGpuLayers) && resolvedGpuLayers >= 0
      ? Math.floor(resolvedGpuLayers)
      : -1;
  return { flags, resolvedGpuLayers: safeResolvedGpuLayers };
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
    // No autoCompute info — tell the caller to pass "all" to llama-server.
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
