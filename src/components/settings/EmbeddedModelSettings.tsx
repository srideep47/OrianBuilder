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

interface GpuInfo {
  available: boolean;
  name: string;
  vramMb: number;
  computeCapability: number;
  hasTensorCores: boolean;
  tensorCoreGen: string;
  recommendedGpuLayers: number;
}

interface ServerStatus {
  running: boolean;
  modelLoaded: boolean;
  modelPath: string | null;
  isLoading: boolean;
}

interface SavedConfig {
  modelPath: string | null;
  gpuLayers: number;
  contextSize: number;
}

export function EmbeddedModelSettings() {
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [savedConfig, setSavedConfig] = useState<SavedConfig | null>(null);
  const [gpuLayers, setGpuLayers] = useState(99);
  const [contextSize, setContextSize] = useState(8192);
  const [isLoadingModel, setIsLoadingModel] = useState(false);

  const refreshStatus = useCallback(async () => {
    const s = await (ipc as any).invoke("embedded-model:get-status");
    setStatus(s);
  }, []);

  useEffect(() => {
    (async () => {
      const [gpu, s, cfg] = await Promise.all([
        (ipc as any).invoke("embedded-model:detect-gpu"),
        (ipc as any).invoke("embedded-model:get-status"),
        (ipc as any).invoke("embedded-model:get-saved-config"),
      ]);
      setGpuInfo(gpu);
      setStatus(s);
      setSavedConfig(cfg);
      if (gpu?.recommendedGpuLayers) setGpuLayers(gpu.recommendedGpuLayers);
      if (cfg?.gpuLayers) setGpuLayers(cfg.gpuLayers);
      if (cfg?.contextSize) setContextSize(cfg.contextSize);
    })();
  }, []);

  const handleSelectGguf = async () => {
    const path = await (ipc as any).invoke("embedded-model:select-gguf");
    if (!path) return;
    setSavedConfig((prev) => ({
      ...(prev ?? { gpuLayers, contextSize }),
      modelPath: path,
    }));
  };

  const handleLoadModel = async () => {
    if (!savedConfig?.modelPath) {
      showError("Please select a GGUF model file first");
      return;
    }
    setIsLoadingModel(true);
    try {
      const result = await (ipc as any).invoke("embedded-model:load", {
        modelPath: savedConfig.modelPath,
        gpuLayers,
        contextSize,
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
    await (ipc as any).invoke("embedded-model:unload");
    showSuccess("Model unloaded");
    await refreshStatus();
  };

  const modelFileName = savedConfig?.modelPath?.split(/[/\\]/).pop();

  return (
    <div className="space-y-6 p-4">
      {/* GPU Info Card */}
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <div className="flex items-center gap-2 font-semibold text-sm">
          <Zap className="w-4 h-4 text-yellow-500" />
          GPU Detection
        </div>
        {gpuInfo ? (
          <div className="text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">GPU</span>
              <span className="font-medium">{gpuInfo.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">VRAM</span>
              <span className="font-medium">
                {(gpuInfo.vramMb / 1024).toFixed(1)} GB
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tensor Cores</span>
              <span
                className={`font-medium ${gpuInfo.hasTensorCores ? "text-green-600" : "text-muted-foreground"}`}
              >
                {gpuInfo.hasTensorCores
                  ? `${gpuInfo.tensorCoreGen}`
                  : "Not available"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">
                Recommended GPU Layers
              </span>
              <span className="font-medium">
                {gpuInfo.recommendedGpuLayers}
              </span>
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">Detecting GPU...</div>
        )}
      </div>

      {/* Model Status */}
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <div className="flex items-center gap-2 font-semibold text-sm">
          <Cpu className="w-4 h-4" />
          Model Status
        </div>
        {status ? (
          <div className="flex items-center gap-2 text-sm">
            {status.modelLoaded ? (
              <>
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                <span className="text-green-700 dark:text-green-400">
                  Loaded: {status.modelPath?.split(/[/\\]/).pop()}
                </span>
              </>
            ) : status.isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Loading model...</span>
              </>
            ) : (
              <>
                <AlertCircle className="w-4 h-4 text-yellow-600" />
                <span className="text-muted-foreground">No model loaded</span>
              </>
            )}
          </div>
        ) : null}
      </div>

      {/* Model Configuration */}
      <div className="rounded-lg border bg-card p-4 space-y-4">
        <div className="font-semibold text-sm">Load GGUF Model</div>

        {/* File selector */}
        <div className="space-y-2">
          <label className="text-sm text-muted-foreground">
            Model File (.gguf)
          </label>
          <div className="flex gap-2 items-center">
            <div className="flex-1 text-sm border rounded px-3 py-1.5 bg-background truncate min-w-0">
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
            Point to your existing GGUF file (e.g. the Qwen3.6-27B-Q4_K_M.gguf
            in LM Studio models folder)
          </p>
        </div>

        {/* GPU Layers */}
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
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>0 (CPU only)</span>
            <span>100 (GPU max)</span>
          </div>
        </div>

        {/* Context Size */}
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">
            Context Size:{" "}
            <span className="font-medium text-foreground">
              {contextSize.toLocaleString()} tokens
            </span>
          </label>
          <select
            value={contextSize}
            onChange={(e) => setContextSize(Number(e.target.value))}
            className="w-full border rounded px-3 py-1.5 text-sm bg-background"
          >
            <option value={4096}>4,096</option>
            <option value={8192}>8,192 (recommended)</option>
            <option value={16384}>16,384</option>
            <option value={32768}>32,768</option>
          </select>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2">
          <Button
            onClick={handleLoadModel}
            disabled={isLoadingModel || !savedConfig?.modelPath}
            className="flex-1"
          >
            {isLoadingModel ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Loading...
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
        After loading, select <strong>Embedded (Tensor)</strong> as your AI
        provider in the model picker. The model uses CUDA tensor cores
        automatically on supported NVIDIA GPUs.
      </p>
    </div>
  );
}
