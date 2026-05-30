import { ipc, type EmbeddedModelConfig } from "@/ipc/types";
import type { UserSettings } from "@/lib/schemas";

const DEFAULT_EMBEDDED_MODEL_CONFIG: EmbeddedModelConfig = {
  modelPath: "",
  inferenceBackend: "llama-cpp",
  tensorRtEngineDir: null,
  gpuMemoryUtilization: 0.98,
  vramHeadroomMb: 512,
  contextSize: 8192,
  batchSize: 512,
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  repeatPenalty: 1.1,
  seed: null,
  flashAttention: true,
  aggressiveMemory: true,
  gpuLayersMode: "auto",
  manualGpuLayers: null,
  selectedGpuModel: null,
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
