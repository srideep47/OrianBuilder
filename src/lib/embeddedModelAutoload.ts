import { ipc, type EmbeddedModelConfig } from "@/ipc/types";
import type { UserSettings } from "@/lib/schemas";

// ── Defaults tuned for RTX 3060 6 GB / Ryzen 7 5800H / 16 GB RAM ────────────
//
//  GPU:  RTX 3060 — Ampere SM 8.6, 6 144 MB VRAM, full Flash-Attention support
//  CPU:  Ryzen 7 5800H — 8 physical cores / 16 threads
//  RAM:  16 GB
//
//  Qwen3-8B Q4_K_M on 6 GB VRAM budget math
//  ─────────────────────────────────────────
//  Loaded weights (Q4 factor 0.82):  4 900 MB × 0.82 ≈ 4 018 MB
//  Per-layer:                         4 018 / 36      ≈   112 MB
//  Budget (90 % util − 768 MB):       6 144×0.90−768  = 4 762 MB
//  All 36 layers fit:                 36×112           = 4 032 MB → OK
//  VRAM left for KV cache:            4 762−4 032      =   730 MB
//
//  KV cache bytes/token/layer
//    FP16  = 2×8 KV-heads×128 dim×2 = 4 096 B  → max ctx ≈  5 K
//    Q8_0  = half of FP16           = 2 048 B  → max ctx ≈ 10 K
//
//  The auto GPU-layer calculator will trade a few CPU-offloaded layers to
//  free VRAM for context, targeting the OrianBuilder 32 K minimum.
//  Flash attention is required when cacheTypeK/V != f16.
const DEFAULT_EMBEDDED_MODEL_CONFIG: EmbeddedModelConfig = {
  modelPath: "",
  inferenceBackend: "llama-cpp",
  tensorRtEngineDir: null,

  // 90 % of 6 GB = 5 530 MB allocated; safer than 98 % on a 6 GB card.
  // Prevents OOM when the driver + CUDA runtime also occupy VRAM at startup.
  gpuMemoryUtilization: 0.90,

  // 768 MB headroom: CUDA context + cuBLAS workspace on RTX 3060 uses ~600 MB.
  // 512 was too tight and caused random OOM on the first large prompt.
  vramHeadroomMb: 768,

  // 32 K is the OrianBuilder minimum (system prompt + codebase = 30-60 K tokens).
  // The auto-mode layer calculator will accept fewer GPU layers if needed to
  // keep this context window within the VRAM budget.
  contextSize: 32768,

  // 512 tokens/batch is a good balance for RTX 3060 — higher doesn't help
  // since the 3060's memory bandwidth (360 GB/s) saturates quickly.
  batchSize: 512,

  // Sampling defaults — balanced for code generation (OrianBuilder's primary use)
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  repeatPenalty: 1.0,
  seed: null,

  // Flash attention is required on Ampere (SM 8.6) and mandatory when
  // cacheTypeK/V are set to anything other than f16.
  flashAttention: true,
  aggressiveMemory: true,
  gpuLayersMode: "auto",
  manualGpuLayers: null,
  selectedGpuModel: null,

  // Q8_0 KV cache: halves KV memory at < 0.5 % quality loss.
  // Gives ~2× more context budget vs FP16 KV.  Requires flashAttention=true.
  // Q8_0 keeps 8-bit precision (vs Q4_0 at 4-bit) — best quality/size tradeoff.
  cacheTypeK: "q8_0",
  cacheTypeV: "q8_0",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForCurrentLoad(): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await ipc.embeddedModel.getStatus(undefined);
    if (status.modelLoaded) return true;
    if (!status.isLoading) return false;
    await sleep(1000);
  }
  return false;
}

async function getSavedLoadConfig(): Promise<EmbeddedModelConfig | null> {
  const saved = await ipc.embeddedModel.getSavedConfig(undefined);
  const inferenceBackend = saved.inferenceBackend ?? "llama-cpp";
  const modelPath = saved.modelPath ?? "";

  if (inferenceBackend === "llama-cpp" && !modelPath) {
    return null;
  }
  if (inferenceBackend === "tensorrt-native" && !saved.tensorRtEngineDir) {
    return null;
  }

  return {
    ...DEFAULT_EMBEDDED_MODEL_CONFIG,
    ...saved,
    modelPath,
    inferenceBackend,
    tensorRtEngineDir: saved.tensorRtEngineDir ?? null,
    seed: saved.seed ?? null,
  };
}

export async function ensureSelectedEmbeddedModelReady(
  settings: UserSettings | null | undefined,
): Promise<void> {
  if (settings?.selectedModel.provider !== "embedded") {
    return;
  }

  const status = await ipc.embeddedModel.getStatus(undefined);
  if (status.modelLoaded) return;
  if (status.isLoading && (await waitForCurrentLoad())) return;

  const config = await getSavedLoadConfig();
  if (!config) {
    throw new Error(
      "No saved Engine model is available. Open Engine, choose a model, save/load it once, then run the prompt again.",
    );
  }

  const result = await ipc.embeddedModel.loadModel(config);
  if (!result.success) {
    throw new Error(result.error ?? "Failed to load the saved Engine model.");
  }
}
