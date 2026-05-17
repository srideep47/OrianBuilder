import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ipc, type EmbeddedModelConfig } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";

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
};

export async function buildEmbeddedModelConfigForPath(
  modelPath: string,
): Promise<EmbeddedModelConfig> {
  const saved = await ipc.embeddedModel.getSavedConfig(undefined);
  return {
    ...DEFAULT_EMBEDDED_MODEL_CONFIG,
    ...saved,
    modelPath,
    inferenceBackend: saved.inferenceBackend ?? "llama-cpp",
    tensorRtEngineDir: saved.tensorRtEngineDir ?? null,
  };
}

export function useEmbeddedModelSwap() {
  const queryClient = useQueryClient();

  const invalidateStatus = async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.embeddedModel.status(),
    });
  };

  const swapMutation = useMutation({
    mutationFn: async (newConfig: EmbeddedModelConfig) =>
      ipc.embeddedModel.swapModel({ newConfig }),
    onSuccess: invalidateStatus,
    meta: { showErrorToast: true },
  });

  const unloadMutation = useMutation({
    mutationFn: async () => ipc.embeddedModel.unloadModel(undefined),
    onSuccess: invalidateStatus,
    meta: { showErrorToast: true },
  });

  return {
    swapModel: swapMutation.mutateAsync,
    unloadModel: unloadMutation.mutateAsync,
    isSwapping: swapMutation.isPending || unloadMutation.isPending,
  };
}
