import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/ipc/types";
import { showError, showSuccess } from "@/lib/toast";
import {
  Cpu,
  FolderOpen,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Zap,
} from "lucide-react";
import type { GpuInfo, EmbeddedServerStatus } from "@/ipc/types";

export function EmbeddedModelSettings() {
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const [status, setStatus] = useState<EmbeddedServerStatus | null>(null);
  const [modelPath, setModelPath] = useState<string | null>(null);
  const [gpuLayers, setGpuLayers] = useState(99);
  const [contextSize, setContextSize] = useState(8192);
  const [isLoadingModel, setIsLoadingModel] = useState(false);

  const refreshStatus = useCallback(async () => {
    const s = await ipc.embeddedModel.getStatus();
    setStatus(s);
  }, []);

  useEffect(() => {
    (async () => {
      const [gpu, s, cfg] = await Promise.all([
        ipc.embeddedModel.detectGpu(undefined),
        ipc.embeddedModel.getStatus(),
        ipc.embeddedModel.getSavedConfig(),
      ]);
      setGpuInfo(gpu);
      setStatus(s);
      setModelPath((cfg as any).modelPath ?? null);
      if ((cfg as any).gpuLayers) setGpuLayers((cfg as any).gpuLayers);
      if ((cfg as any).contextSize) setContextSize((cfg as any).contextSize);
      if (gpu?.recommendedGpuLayers && !(cfg as any).gpuLayers) {
        setGpuLayers(gpu.recommendedGpuLayers);
      }
    })();
  }, []);

  const handleSelectGguf = async () => {
    const path = await ipc.embeddedModel.selectGguf();
    if (path) setModelPath(path);
  };

  const handleLoadModel = async () => {
    if (!modelPath) {
      showError("Please select a GGUF model file first");
      return;
    }
    setIsLoadingModel(true);
    try {
      const result = await ipc.embeddedModel.loadModel({
        modelPath,
        gpuLayers,
        contextSize,
        batchSize: 512,
        temperature: 0.7,
        topP: 0.95,
        topK: 40,
        repeatPenalty: 1.1,
        seed: null,
        flashAttention: true,
      });
      if (result.success) {
        showSuccess("Model loaded successfully");
        await refreshStatus();
      } else {
        showError(`Failed to load model: ${result.error}`);
      }
    } finally {
      setIsLoadingModel(false);
    }
  };

  const handleUnload = async () => {
    await ipc.embeddedModel.unloadModel();
    showSuccess("Model unloaded");
    await refreshStatus();
  };

  const modelFileName = modelPath?.split(/[/\\]/).pop();

  return (
    <div className="space-y-6 p-4">
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <div className="flex items-center gap-2 font-semibold text-sm">
          <Zap className="w-4 h-4 text-yellow-500" />
          GPU Detection
        </div>
        {gpuInfo ? (
          <div className="text-sm space-y-1">
            {[
              ["GPU", gpuInfo.name],
              ["VRAM", `${(gpuInfo.vramMb / 1024).toFixed(1)} GB`],
              [
                "Tensor Cores",
                gpuInfo.hasTensorCores
                  ? gpuInfo.tensorCoreGen
                  : "Not available",
              ],
              ["Recommended GPU Layers", String(gpuInfo.recommendedGpuLayers)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-muted-foreground">{k}</span>
                <span className="font-medium">{v}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Detecting GPU…</div>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-2">
        <div className="flex items-center gap-2 font-semibold text-sm">
          <Cpu className="w-4 h-4" />
          Model Status
        </div>
        {status && (
          <div className="flex items-center gap-2 text-sm">
            {status.modelLoaded ? (
              <>
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                <span className="text-green-700 dark:text-green-400">
                  Loaded: {status.modelName}
                </span>
              </>
            ) : status.isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Loading model…</span>
              </>
            ) : (
              <>
                <AlertCircle className="w-4 h-4 text-yellow-600" />
                <span className="text-muted-foreground">No model loaded</span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-4">
        <div className="font-semibold text-sm">Load GGUF Model</div>
        <div className="space-y-2">
          <label className="text-sm text-muted-foreground">
            Model File (.gguf)
          </label>
          <div className="flex gap-2 items-center">
            <div className="flex-1 text-sm border rounded px-3 py-1.5 bg-background truncate min-w-0 font-mono">
              {modelFileName ?? (
                <span className="text-muted-foreground">No file selected</span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={handleSelectGguf}>
              <FolderOpen className="w-4 h-4 mr-1" />
              Browse
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Point to your GGUF file — e.g. Qwen3.6-27B-Q4_K_M.gguf in LM Studio
            models folder.
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">
            GPU Layers:{" "}
            <span className="font-medium text-foreground">{gpuLayers}</span>
            {gpuInfo && ` (recommended: ${gpuInfo.recommendedGpuLayers})`}
          </label>
          <input
            type="range"
            min={0}
            max={100}
            value={gpuLayers}
            onChange={(e) => setGpuLayers(Number(e.target.value))}
            className="w-full accent-primary"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">Context Size</label>
          <select
            value={contextSize}
            onChange={(e) => setContextSize(Number(e.target.value))}
            className="w-full border rounded px-3 py-1.5 text-sm bg-background"
          >
            {[4096, 8192, 16384, 32768].map((v) => (
              <option key={v} value={v}>
                {v.toLocaleString()} tokens
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-2">
          <Button
            onClick={handleLoadModel}
            disabled={isLoadingModel || !modelPath}
            className="flex-1"
          >
            {isLoadingModel ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Loading…
              </>
            ) : (
              <>
                <Zap className="w-4 h-4 mr-2" />
                Load Model
              </>
            )}
          </Button>
          {status?.modelLoaded && (
            <Button variant="outline" onClick={handleUnload}>
              Unload
            </Button>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        For full settings (temperature, top-p, batch size, flash attention…)
        open the <strong>Engine</strong> screen from the sidebar.
      </p>
    </div>
  );
}
