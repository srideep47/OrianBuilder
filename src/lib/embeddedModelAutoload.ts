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
  gpuMemoryUtilization: 0.9,

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

/** True when the user has cloud credentials we could actually use — an
 *  OrianBuilder Pro account or any configured provider API key. Used to decide
 *  whether to prefer the local embedded model for Orion when the picker is on a
 *  cloud / "auto" model. */
function hasCloudCredentials(
  settings: UserSettings | null | undefined,
): boolean {
  if (!settings) return false;
  if (settings.enableOrianBuilderPro) return true;
  const providerSettings = settings.providerSettings ?? {};
  return Object.values(providerSettings).some((provider) => {
    const value = (provider as { apiKey?: { value?: unknown } } | null)?.apiKey
      ?.value;
    return typeof value === "string" && value.length > 0;
  });
}

/**
 * Ensure the Orion command has a usable model before it runs.
 *
 * The Orion pipeline (intent parse → asset planning → autonomous agent build)
 * resolves the LLM from `settings.selectedModel`. On a local / offline machine
 * the default "auto" (cloud) selection can't be used — there are no cloud keys
 * and the cloud is unreachable — so every Orion LLM call fails and the build
 * never launches. When that's the case and a local embedded model is available,
 * load it and point the model picker at it so Orion (and the rest of the app)
 * use the local model instead of a dead "Auto".
 *
 * Users who DO have cloud credentials keep their chosen model — their other
 * workflows are not disturbed.
 */
export async function ensureUsableModelForOrion(
  settings: UserSettings | null | undefined,
  selectEmbeddedModel?: (model: {
    name: string;
    provider: "embedded";
  }) => Promise<unknown> | unknown,
  onStatus?: (message: string) => Promise<unknown> | unknown,
): Promise<void> {
  // Embedded already selected → just make sure it's actually loaded.
  if (settings?.selectedModel.provider === "embedded") {
    const loaded = (await ipc.embeddedModel.getStatus(undefined)).modelLoaded;
    if (!loaded) {
      await onStatus?.(
        "Loading your local model — the first load after launch can take a few minutes.",
      );
    }
    await ensureSelectedEmbeddedModelReady(settings);
    return;
  }

  // A cloud / "auto" model is selected and the user has cloud credentials →
  // respect their choice; don't switch them to the local model.
  if (hasCloudCredentials(settings)) {
    return;
  }

  // Cloud / "auto" selected but unusable here. Prefer a local embedded model.
  let status = await ipc.embeddedModel.getStatus(undefined);
  if (!status.modelLoaded) {
    if (status.isLoading) {
      await onStatus?.(
        "Loading your local model — the first load after launch can take a few minutes.",
      );
      await waitForCurrentLoad();
    } else {
      const config = await getSavedLoadConfig();
      // No local model configured either — nothing to fall back to. Leave the
      // selection as-is so the caller surfaces a clear cloud/setup error.
      if (!config) return;
      await onStatus?.(
        "Loading your local model — the first load after launch can take a few minutes.",
      );
      const result = await ipc.embeddedModel.loadModel(config);
      if (!result.success) {
        throw new Error(
          result.error ?? "Failed to load the local Engine model for Orion.",
        );
      }
    }
    status = await ipc.embeddedModel.getStatus(undefined);
  }

  // Reflect the now-loaded local model in the picker so Orion and the rest of
  // the app use it (and the dropdown stops showing a dead "Auto").
  if (status.modelLoaded && status.modelName && selectEmbeddedModel) {
    await selectEmbeddedModel({
      name: status.modelName,
      provider: "embedded",
    });
  }
}
