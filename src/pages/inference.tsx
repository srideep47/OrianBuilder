import { useState, useEffect, useCallback, useRef } from "react";
import { ipc } from "@/ipc/types";
import type {
  GpuInfo,
  GpuStats,
  EmbeddedServerStatus,
  EmbeddedModelConfig,
} from "@/ipc/types";
import { showError, showSuccess } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Cpu,
  FolderOpen,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Zap,
  Settings2,
  BarChart3,
  Power,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Thermometer,
  Activity,
  HardDrive,
  Gauge,
} from "lucide-react";

// ─── helpers ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  unit,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string | number;
  unit?: string;
  icon: React.ElementType;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 flex flex-col gap-1 min-w-0">
      <div
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium",
          accent ?? "text-muted-foreground",
        )}
      >
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums leading-none mt-1">
        {value}
        <span className="text-sm font-normal text-muted-foreground ml-1">
          {unit}
        </span>
      </div>
    </div>
  );
}

function VramBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const color =
    pct > 90 ? "bg-red-500" : pct > 70 ? "bg-yellow-500" : "bg-green-500";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>VRAM</span>
        <span>
          {(used / 1024).toFixed(1)} / {(total / 1024).toFixed(1)} GB (
          {pct.toFixed(0)}%)
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-center">
        <label className="text-sm font-medium">{label}</label>
        <span className="text-sm tabular-nums text-muted-foreground font-mono">
          {value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary h-1.5 cursor-pointer"
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full border rounded-md px-3 py-1.5 text-sm bg-background font-mono"
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ToggleField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
          checked ? "bg-primary" : "bg-input",
        )}
      >
        <span
          className={cn(
            "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-lg ring-0 transition-transform",
            checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </button>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: React.ElementType;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2.5 font-semibold text-sm">
          <Icon className="w-4 h-4 text-primary" />
          {title}
        </div>
        {open ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="px-5 pb-5 pt-1 space-y-4 border-t">{children}</div>
      )}
    </div>
  );
}

// ─── default config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: EmbeddedModelConfig = {
  modelPath: "",
  gpuLayers: 99,
  contextSize: 8192,
  batchSize: 512,
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  repeatPenalty: 1.1,
  seed: null,
  flashAttention: true,
};

// ─── main page ───────────────────────────────────────────────────────────────

export default function InferencePage() {
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const [gpuStats, setGpuStats] = useState<GpuStats | null>(null);
  const [status, setStatus] = useState<EmbeddedServerStatus | null>(null);
  const [config, setConfig] = useState<EmbeddedModelConfig>(DEFAULT_CONFIG);
  const [isLoadingModel, setIsLoadingModel] = useState(false);
  const statsInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const patch = useCallback((partial: Partial<EmbeddedModelConfig>) => {
    setConfig((prev) => ({ ...prev, ...partial }));
  }, []);

  const refreshStatus = useCallback(async () => {
    const s = await ipc.embeddedModel.getStatus();
    setStatus(s);
  }, []);

  // Initial load
  useEffect(() => {
    (async () => {
      const [gpu, s, cfg] = await Promise.all([
        ipc.embeddedModel.detectGpu(undefined),
        ipc.embeddedModel.getStatus(),
        ipc.embeddedModel.getSavedConfig(),
      ]);
      setGpuInfo(gpu);
      setStatus(s);
      const merged: EmbeddedModelConfig = {
        ...DEFAULT_CONFIG,
        ...(cfg as Partial<EmbeddedModelConfig>),
        modelPath: (cfg as any).modelPath ?? "",
      };
      setConfig(merged);
      if (gpu?.recommendedGpuLayers && !cfg?.gpuLayers) {
        patch({ gpuLayers: gpu.recommendedGpuLayers });
      }
    })();
  }, [patch]);

  // Live GPU stats polling
  useEffect(() => {
    statsInterval.current = setInterval(async () => {
      const stats = await ipc.embeddedModel.getGpuStats();
      setGpuStats(stats);
    }, 2000);
    statusInterval.current = setInterval(refreshStatus, 3000);
    return () => {
      if (statsInterval.current) clearInterval(statsInterval.current);
      if (statusInterval.current) clearInterval(statusInterval.current);
    };
  }, [refreshStatus]);

  const handleBrowse = async () => {
    const path = await ipc.embeddedModel.selectGguf();
    if (path) patch({ modelPath: path });
  };

  const handleLoad = async () => {
    if (!config.modelPath) {
      showError("Select a GGUF file first");
      return;
    }
    setIsLoadingModel(true);
    try {
      const result = await ipc.embeddedModel.loadModel(config);
      if (result.success) {
        showSuccess("Model loaded — ready for inference");
        await refreshStatus();
      } else {
        showError(`Load failed: ${result.error}`);
      }
    } finally {
      setIsLoadingModel(false);
    }
  };

  const handleUnload = async () => {
    const result = await ipc.embeddedModel.unloadModel();
    if (result.success) {
      showSuccess("Model unloaded");
      await refreshStatus();
    } else showError(`Unload failed: ${result.error}`);
  };

  const handleSaveConfig = async () => {
    await ipc.embeddedModel.saveConfig(config);
    showSuccess("Configuration saved");
  };

  const modelLoaded = status?.modelLoaded ?? false;
  const modelName =
    status?.modelName ?? config.modelPath.split(/[/\\]/).pop() ?? "";

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-500" />
            Inference Engine
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Embedded tensor core inference · node-llama-cpp · CUDA{" "}
            {gpuInfo?.tensorCoreGen ?? "—"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {modelLoaded ? (
            <span className="flex items-center gap-1.5 text-xs font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30 px-3 py-1.5 rounded-full border border-green-200 dark:border-green-800">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Active · {modelName}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground bg-muted px-3 py-1.5 rounded-full border">
              <AlertCircle className="w-3.5 h-3.5" />
              No model loaded
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 px-6 py-5 space-y-5 max-w-4xl mx-auto w-full">
        {/* ── Live Stats ── */}
        <Section title="Live GPU Stats" icon={BarChart3}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard
              label="GPU Util"
              value={gpuStats?.utilizationPercent.toFixed(0) ?? "—"}
              unit="%"
              icon={Activity}
              accent={
                gpuStats && gpuStats.utilizationPercent > 80
                  ? "text-yellow-600"
                  : undefined
              }
            />
            <StatCard
              label="Temperature"
              value={gpuStats?.temperatureC.toFixed(0) ?? "—"}
              unit="°C"
              icon={Thermometer}
              accent={
                gpuStats && gpuStats.temperatureC > 85
                  ? "text-red-500"
                  : undefined
              }
            />
            <StatCard
              label="Power"
              value={gpuStats?.powerW.toFixed(0) ?? "—"}
              unit="W"
              icon={Zap}
            />
            <StatCard
              label="Clock"
              value={gpuStats?.clockMhz.toFixed(0) ?? "—"}
              unit="MHz"
              icon={Gauge}
            />
          </div>
          {gpuStats && (
            <VramBar used={gpuStats.vramUsedMb} total={gpuStats.vramTotalMb} />
          )}
          {!gpuStats && (
            <p className="text-xs text-muted-foreground">
              nvidia-smi not detected — stats unavailable
            </p>
          )}
        </Section>

        {/* ── GPU Info ── */}
        <Section title="GPU Detection" icon={HardDrive} defaultOpen={false}>
          {gpuInfo ? (
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              {[
                ["GPU", gpuInfo.name],
                ["VRAM", `${(gpuInfo.vramMb / 1024).toFixed(1)} GB`],
                ["Compute Capability", gpuInfo.computeCapability.toFixed(1)],
                [
                  "Tensor Cores",
                  gpuInfo.hasTensorCores
                    ? `${gpuInfo.tensorCoreGen}`
                    : "Not available",
                ],
                [
                  "Recommended GPU Layers",
                  String(gpuInfo.recommendedGpuLayers),
                ],
              ].map(([k, v]) => (
                <div
                  key={k}
                  className="flex justify-between border-b border-dashed border-muted py-1.5"
                >
                  <span className="text-muted-foreground">{k}</span>
                  <span
                    className={cn(
                      "font-medium",
                      k === "Tensor Cores" && gpuInfo.hasTensorCores
                        ? "text-green-600 dark:text-green-400"
                        : "",
                    )}
                  >
                    {v}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Detecting GPU…
            </div>
          )}
        </Section>

        {/* ── Model Loader ── */}
        <Section title="Model" icon={Cpu}>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">
                GGUF File
              </label>
              <div className="flex gap-2">
                <div className="flex-1 border rounded-lg px-3 py-2 text-sm bg-background font-mono truncate text-muted-foreground min-w-0">
                  {config.modelPath || "No file selected"}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBrowse}
                  disabled={isLoadingModel}
                >
                  <FolderOpen className="w-4 h-4 mr-1.5" />
                  Browse
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                Point to any GGUF model file — including the Qwen3.6-27B already
                in your LM Studio models folder.
              </p>
            </div>

            <div className="flex gap-2 pt-1">
              <Button
                onClick={handleLoad}
                disabled={isLoadingModel || !config.modelPath}
                className="flex-1"
              >
                {isLoadingModel ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Loading model…
                  </>
                ) : (
                  <>
                    <Zap className="w-4 h-4 mr-2" />
                    Load Model
                  </>
                )}
              </Button>
              {modelLoaded && (
                <Button
                  variant="outline"
                  onClick={handleUnload}
                  disabled={isLoadingModel}
                >
                  <Power className="w-4 h-4 mr-1.5" />
                  Unload
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={refreshStatus}
                title="Refresh status"
              >
                <RefreshCw className="w-4 h-4" />
              </Button>
            </div>

            {isLoadingModel && (
              <div className="rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 px-4 py-3 text-sm text-yellow-800 dark:text-yellow-300">
                Loading a large model can take 30–120 seconds. GPU layers are
                being allocated…
              </div>
            )}
          </div>
        </Section>

        {/* ── Memory & Compute Settings ── */}
        <Section title="Memory & Compute" icon={Settings2}>
          <div className="space-y-5">
            <SliderField
              label="GPU Layers"
              value={config.gpuLayers}
              min={0}
              max={100}
              onChange={(v) => patch({ gpuLayers: v })}
              hint={
                gpuInfo
                  ? `Recommended for your ${gpuInfo.name}: ${gpuInfo.recommendedGpuLayers} layers. Higher = more VRAM used, faster inference.`
                  : "Number of transformer layers to offload to the GPU."
              }
            />
            <NumberField
              label="Context Size (tokens)"
              value={config.contextSize}
              min={512}
              max={131072}
              step={512}
              onChange={(v) => patch({ contextSize: v })}
              hint="KV cache size. Larger = more VRAM. 8192 is recommended for Qwen3.6-27B on 16 GB VRAM."
            />
            <NumberField
              label="Batch Size"
              value={config.batchSize}
              min={64}
              max={2048}
              step={64}
              onChange={(v) => patch({ batchSize: v })}
              hint="Tokens processed per batch during prefill. 512 is a good default for Ada GPUs."
            />
            <ToggleField
              label="Flash Attention"
              checked={config.flashAttention}
              onChange={(v) => patch({ flashAttention: v })}
              hint="Fused attention kernel. Faster and uses less VRAM. Requires Ada / Ampere GPU (CC ≥ 8.0)."
            />
          </div>
        </Section>

        {/* ── Sampling Settings ── */}
        <Section title="Sampling" icon={Activity} defaultOpen={false}>
          <div className="space-y-5">
            <SliderField
              label="Temperature"
              value={config.temperature}
              min={0}
              max={2}
              step={0.05}
              onChange={(v) => patch({ temperature: v })}
              hint="Controls randomness. 0 = deterministic, 1 = balanced, 2 = very creative."
            />
            <SliderField
              label="Top-P (nucleus sampling)"
              value={config.topP}
              min={0.1}
              max={1}
              step={0.05}
              onChange={(v) => patch({ topP: v })}
              hint="Only sample from tokens whose cumulative probability exceeds this value."
            />
            <NumberField
              label="Top-K"
              value={config.topK}
              min={1}
              max={200}
              step={1}
              onChange={(v) => patch({ topK: v })}
              hint="Limit token selection to the top K candidates. Lower = more focused."
            />
            <SliderField
              label="Repeat Penalty"
              value={config.repeatPenalty}
              min={1}
              max={2}
              step={0.05}
              onChange={(v) => patch({ repeatPenalty: v })}
              hint="Penalises recently generated tokens. 1.0 = off, 1.1 recommended."
            />
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Seed</label>
              <input
                type="number"
                placeholder="Random (leave empty)"
                value={config.seed ?? ""}
                onChange={(e) =>
                  patch({
                    seed: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                className="w-full border rounded-md px-3 py-1.5 text-sm bg-background font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Fixed seed for reproducible outputs. Leave blank for random.
              </p>
            </div>
          </div>
        </Section>

        {/* ── Save Config ── */}
        <div className="flex justify-end pb-6">
          <Button variant="outline" onClick={handleSaveConfig}>
            Save Configuration
          </Button>
        </div>
      </div>
    </div>
  );
}
