import { useState, useEffect, useCallback, useRef } from "react";
import { ipc } from "@/ipc/types";
import type {
  GpuInfo,
  GpuStats,
  EmbeddedServerStatus,
  EmbeddedModelConfig,
  ModelInfo,
  LocalModelEntry,
  InferenceStats,
  InferenceLogEntry,
  TensorRtEngineBuildStatus,
} from "@/ipc/types";
import { showError, showSuccess } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@tanstack/react-router";
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
  Info,
  Database,
  Brain,
  Wrench,
  Sparkles,
  FlaskConical,
  ScrollText,
} from "lucide-react";

// ─── helpers ─────────────────────────────────────────────────────────────────

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

function formatMemoryMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(mb))} MB`;
}

function getEffectiveKvContextSize(
  contextSize: number,
  attentionSlidingWindow?: number | null,
  attentionSlidingWindowPattern?: number | null,
  flashAttention?: boolean,
): number {
  const slidingWindow = attentionSlidingWindow ?? 0;
  if (slidingWindow <= 0 || slidingWindow >= contextSize) {
    return contextSize;
  }
  const pattern = Math.max(1, attentionSlidingWindowPattern ?? 1);
  const nonSwaPercent =
    pattern <= 1 ? 1 : 1 / (pattern + (flashAttention ? -0.5 : -1));
  return Math.ceil(
    (1 - nonSwaPercent) * slidingWindow + nonSwaPercent * contextSize,
  );
}

function getContextSizeForEffectiveKv(
  effectiveContextSize: number,
  attentionSlidingWindow?: number | null,
  attentionSlidingWindowPattern?: number | null,
  flashAttention?: boolean,
): number {
  const slidingWindow = attentionSlidingWindow ?? 0;
  if (slidingWindow <= 0 || effectiveContextSize <= slidingWindow) {
    return effectiveContextSize;
  }
  const pattern = Math.max(1, attentionSlidingWindowPattern ?? 1);
  const nonSwaPercent =
    pattern <= 1 ? 1 : 1 / (pattern + (flashAttention ? -0.5 : -1));
  if (nonSwaPercent >= 1) {
    return effectiveContextSize;
  }
  return Math.floor(
    (effectiveContextSize - (1 - nonSwaPercent) * slidingWindow) /
      nonSwaPercent,
  );
}

function VramBar({
  used,
  total,
  overflow = 0,
}: {
  used: number;
  total: number;
  overflow?: number;
}) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const color =
    pct > 90 ? "bg-red-500" : pct > 70 ? "bg-yellow-500" : "bg-green-500";
  const isOverflowing = overflow > 64;
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
          className={cn(
            "h-full rounded-full transition-all duration-500",
            color,
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div
        className={cn(
          "flex justify-between text-[11px]",
          isOverflowing ? "text-red-500" : "text-muted-foreground",
        )}
      >
        <span>System RAM spill</span>
        <span>{formatMemoryMb(overflow)}</span>
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
  badge,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  hint?: string;
  badge?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-center gap-2">
        <label className="text-sm font-medium">{label}</label>
        <div className="flex items-center gap-2">
          {badge && (
            <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-medium">
              {badge}
            </span>
          )}
          <span className="text-sm tabular-nums text-muted-foreground font-mono bg-muted px-2 py-0.5 rounded">
            {value}
          </span>
        </div>
      </div>
      <div className="relative">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full accent-primary h-1.5 cursor-pointer"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
          <span>{min}</span>
          <span>{max}</span>
        </div>
      </div>
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
        <div className="px-5 pb-5 pt-2 space-y-5 border-t">{children}</div>
      )}
    </div>
  );
}

// ─── inference monitor (left panel) ──────────────────────────────────────────

type InferenceState = InferenceStats["state"];

const STATE_CONFIG: Record<
  InferenceState,
  {
    label: string;
    color: string;
    bg: string;
    icon: React.ElementType;
    pulse?: boolean;
  }
> = {
  idle: {
    label: "Idle",
    color: "text-muted-foreground",
    bg: "bg-muted",
    icon: Activity,
  },
  loading: {
    label: "Loading…",
    color: "text-blue-600 dark:text-blue-400",
    bg: "bg-blue-50 dark:bg-blue-900/30",
    icon: Loader2,
    pulse: true,
  },
  prefilling: {
    label: "Prefilling",
    color: "text-sky-600 dark:text-sky-400",
    bg: "bg-sky-50 dark:bg-sky-900/30",
    icon: FlaskConical,
  },
  generating: {
    label: "Generating",
    color: "text-green-600 dark:text-green-400",
    bg: "bg-green-50 dark:bg-green-900/30",
    icon: Sparkles,
  },
  thinking: {
    label: "Thinking…",
    color: "text-purple-600 dark:text-purple-400",
    bg: "bg-purple-50 dark:bg-purple-900/30",
    icon: Brain,
    pulse: true,
  },
  tool_calling: {
    label: "Tool Call",
    color: "text-orange-600 dark:text-orange-400",
    bg: "bg-orange-50 dark:bg-orange-900/30",
    icon: Wrench,
  },
};

function SpeedMetric({
  label,
  value,
  primary,
}: {
  label: string;
  value: number;
  primary?: boolean;
}) {
  return (
    <div className="flex flex-col items-center">
      <span
        className={cn(
          "tabular-nums font-bold leading-none",
          primary
            ? "text-xl text-foreground"
            : "text-base text-muted-foreground",
        )}
      >
        {value > 0 ? value.toFixed(1) : "—"}
      </span>
      <span className="text-[10px] text-muted-foreground mt-0.5">{label}</span>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function InferenceMonitor({
  stats,
  logs,
}: {
  stats: InferenceStats | null;
  logs: InferenceLogEntry[];
}) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const state = stats?.state ?? "idle";
  const cfg = STATE_CONFIG[state] ?? STATE_CONFIG.idle;
  const StateIcon = cfg.icon;
  const backendLabel =
    stats?.backend === "tensorrt-native"
      ? "Native TensorRT"
      : stats?.backend === "llama-cpp"
        ? "llama.cpp CUDA"
        : "No backend";

  return (
    <div className="space-y-4">
      {/* State + speed row */}
      <div className="flex gap-3 flex-wrap">
        {/* State badge */}
        <div
          className={cn(
            "rounded-lg px-3 py-2.5 flex items-center gap-2.5 flex-1 min-w-40",
            cfg.bg,
          )}
        >
          <StateIcon
            className={cn(
              "w-4 h-4 shrink-0",
              cfg.color,
              cfg.pulse && "animate-spin",
            )}
          />
          <div className="min-w-0">
            <p className={cn("text-xs font-bold", cfg.color)}>{cfg.label}</p>
            <p className="text-[11px] text-muted-foreground truncate mt-0.5">
              {backendLabel}
            </p>
            {stats?.operation && state !== "idle" && (
              <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                {stats.operation}
              </p>
            )}
          </div>
        </div>

        {/* Speed metrics */}
        <div className="rounded-lg border bg-card px-4 py-2.5 flex-1 min-w-56">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
            <Zap className="w-3 h-3" />
            Speed (tok/s)
          </p>
          <div className="grid grid-cols-4 gap-1 divide-x">
            <SpeedMetric label="Live" value={stats?.liveTps ?? 0} primary />
            <SpeedMetric label="Decode" value={stats?.decodeTps ?? 0} />
            <SpeedMetric label="Prefill" value={stats?.prefillTps ?? 0} />
            <SpeedMetric label="Peak" value={stats?.peakTps ?? 0} />
          </div>
        </div>

        {/* Session stats */}
        <div className="rounded-lg border bg-card px-4 py-2.5 flex-1 min-w-48">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
            <BarChart3 className="w-3 h-3" />
            Session
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <div>
              <span className="text-muted-foreground">Prompt </span>
              <span className="font-bold tabular-nums">
                {stats?.promptTokens.toLocaleString() ?? "0"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Output </span>
              <span className="font-bold tabular-nums">
                {stats?.tokensGenerated.toLocaleString() ?? "0"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Duration </span>
              <span className="font-bold tabular-nums">
                {stats ? formatDuration(stats.sessionDurationMs) : "—"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Prefill </span>
              <span className="font-bold tabular-nums">
                {stats ? formatDuration(stats.prefillDurationMs) : "—"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">All-time </span>
              <span className="font-bold tabular-nums">
                {stats?.totalTokensAllTime.toLocaleString() ?? "0"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Log stream */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="px-3 py-2 border-b flex items-center gap-1.5">
          <ScrollText className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Engine Logs
          </span>
        </div>
        <div
          className="overflow-y-auto p-2 space-y-0.5 font-mono text-[10px]"
          style={{ maxHeight: 240 }}
        >
          {logs.length === 0 ? (
            <p className="text-muted-foreground text-center py-4">
              No logs yet
            </p>
          ) : (
            logs.map((entry, i) => (
              <div
                key={i}
                className={cn(
                  "leading-relaxed break-all",
                  entry.level === "error"
                    ? "text-red-500"
                    : entry.level === "warn"
                      ? "text-yellow-600 dark:text-yellow-400"
                      : "text-muted-foreground",
                )}
              >
                <span className="opacity-50 mr-1.5 select-none">
                  {new Date(entry.ts).toLocaleTimeString([], {
                    hour12: false,
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                {entry.msg}
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}

// ─── defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: EmbeddedModelConfig = {
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

// ─── page ─────────────────────────────────────────────────────────────────────

export default function InferencePage() {
  const [gpuInfo, setGpuInfo] = useState<GpuInfo | null>(null);
  const [gpuStats, setGpuStats] = useState<GpuStats | null>(null);
  const [status, setStatus] = useState<EmbeddedServerStatus | null>(null);
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [config, setConfig] = useState<EmbeddedModelConfig>(DEFAULT_CONFIG);
  const [isLoading, setIsLoading] = useState(false);
  const [isInspecting, setIsInspecting] = useState(false);
  const [library, setLibrary] = useState<LocalModelEntry[]>([]);
  const [inferenceStats, setInferenceStats] = useState<InferenceStats | null>(
    null,
  );
  const [logs, setLogs] = useState<InferenceLogEntry[]>([]);
  const [tensorRtBuildStatus, setTensorRtBuildStatus] =
    useState<TensorRtEngineBuildStatus | null>(null);
  const [tensorRtBuildModelId, setTensorRtBuildModelId] = useState(
    "Qwen/Qwen2.5-0.5B-Instruct",
  );
  const navigate = useNavigate();
  const statsRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const patch = useCallback(
    (p: Partial<EmbeddedModelConfig>) =>
      setConfig((prev) => ({ ...prev, ...p })),
    [],
  );

  const refreshStatus = useCallback(
    async () => setStatus(await ipc.embeddedModel.getStatus()),
    [],
  );

  const inspectFile = useCallback(
    async (filePath: string) => {
      setIsInspecting(true);
      try {
        const info = await ipc.embeddedModel.getModelInfo(filePath);
        setModelInfo(info);
        patch({
          modelPath: filePath,
          gpuMemoryUtilization: 0.98,
          vramHeadroomMb: 512,
          aggressiveMemory: true,
          contextSize: info.recommendedContextSize ?? 8192,
        });
      } catch {
        patch({ modelPath: filePath });
      } finally {
        setIsInspecting(false);
      }
    },
    [patch],
  );

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await ipc.marketplace.listLocalModels());
    } catch {
      /* ignore */
    }
  }, []);

  // Initial data load
  useEffect(() => {
    (async () => {
      const [gpu, s, cfg, lib, recentLogs, currentStats, buildStatus] =
        await Promise.all([
          ipc.embeddedModel.detectGpu(undefined),
          ipc.embeddedModel.getStatus(),
          ipc.embeddedModel.getSavedConfig(),
          ipc.marketplace.listLocalModels(),
          ipc.embeddedModel.getRecentLogs(),
          ipc.embeddedModel.getStats(),
          ipc.embeddedModel.getTensorRtEngineBuildStatus(undefined),
        ]);
      setGpuInfo(gpu);
      setStatus(s);
      setLibrary(lib);
      setLogs(recentLogs);
      setInferenceStats(currentStats);
      setTensorRtBuildStatus(buildStatus);
      const savedPath = (cfg as any).modelPath as string | null;
      setConfig({
        ...DEFAULT_CONFIG,
        ...(cfg as Partial<EmbeddedModelConfig>),
        modelPath: savedPath ?? "",
      });
      if (savedPath) {
        try {
          setModelInfo(await ipc.embeddedModel.getModelInfo(savedPath));
        } catch {
          /* ignore */
        }
      }
    })();
  }, []);

  // GPU stats + status polling
  useEffect(() => {
    statsRef.current = setInterval(
      async () => setGpuStats(await ipc.embeddedModel.getGpuStats()),
      2000,
    );
    statusRef.current = setInterval(refreshStatus, 3000);
    return () => {
      if (statsRef.current) clearInterval(statsRef.current);
      if (statusRef.current) clearInterval(statusRef.current);
    };
  }, [refreshStatus]);

  // Live inference events
  useEffect(() => {
    const unsubStats = ipc.events.embeddedModel.onStats((s) =>
      setInferenceStats(s),
    );
    const unsubLog = ipc.events.embeddedModel.onLog((entry) =>
      setLogs((prev) => [...prev.slice(-299), entry]),
    );
    const unsubTensorRtBuild = ipc.events.embeddedModel.onTensorRtBuildStatus(
      (entry) => {
        setTensorRtBuildStatus(entry);
        if (entry.phase === "done" && entry.outputDir) {
          patch({ tensorRtEngineDir: entry.outputDir });
        }
      },
    );
    return () => {
      unsubStats();
      unsubLog();
      unsubTensorRtBuild();
    };
  }, [patch]);

  useEffect(() => {
    const maxContext = modelInfo?.contextLengthTrained;
    if (maxContext && config.contextSize > maxContext) {
      patch({ contextSize: maxContext });
    }
  }, [config.contextSize, modelInfo?.contextLengthTrained, patch]);

  const handleBrowse = async () => {
    const path = await ipc.embeddedModel.selectGguf();
    if (path) await inspectFile(path);
  };

  const handleBrowseTensorRtEngine = async () => {
    const path = await ipc.embeddedModel.selectTensorRtEngineDir();
    if (path) patch({ tensorRtEngineDir: path });
  };

  const handleBuildTensorRtEngine = async () => {
    const status = await ipc.embeddedModel.startTensorRtEngineBuild({
      modelId: tensorRtBuildModelId,
      outputDir: config.tensorRtEngineDir || null,
      onnxPath: null,
      maxBatch: 1,
      maxInputLen: Math.min(config.contextSize, 4096),
      maxSeqLen: 2048,
      dtype: "fp16",
    });
    setTensorRtBuildStatus(status);
    if (status.phase === "failed") {
      showError(status.message);
    } else {
      showSuccess(
        `TensorRT-LLM engine build started for ${tensorRtBuildModelId}`,
      );
    }
  };

  const handleCancelTensorRtEngineBuild = async () => {
    setTensorRtBuildStatus(await ipc.embeddedModel.cancelTensorRtEngineBuild());
  };

  const handleLoad = async () => {
    if (config.inferenceBackend !== "tensorrt-native" && !config.modelPath) {
      showError("Select a GGUF file first");
      return;
    }
    if (
      config.inferenceBackend === "tensorrt-native" &&
      !config.tensorRtEngineDir
    ) {
      showError("Select a TensorRT engine directory first");
      return;
    }
    setIsLoading(true);
    try {
      const result = await ipc.embeddedModel.loadModel(config);
      if (result.success) {
        await refreshStatus();
        const s = await ipc.embeddedModel.getStatus();
        const gpuMsg =
          s.gpuLayers > 0
            ? `${s.gpuLayers} layers on GPU · ${s.actualContextSize.toLocaleString()} token context`
            : "CPU-only mode (no GPU layers loaded)";
        showSuccess(
          `Model loaded · ${gpuMsg} · pick "Embedded" in the model picker to build`,
        );
      } else {
        showError(result.error ?? "Load failed");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnload = async () => {
    const r = await ipc.embeddedModel.unloadModel();
    if (r.success) {
      showSuccess("Model unloaded");
      await refreshStatus();
    } else showError(`Unload failed: ${r.error}`);
  };

  const modelLoaded = status?.modelLoaded ?? false;
  const modelName =
    status?.modelName ?? config.modelPath.split(/[/\\]/).pop() ?? "";
  const totalLayers = modelInfo?.estimatedLayers ?? 64;
  const layerSizeMb = modelInfo?.layerSizeMb ?? 229;
  const vramMb = gpuInfo?.vramMb ?? 0;
  const vramHeadroomMb = config.vramHeadroomMb ?? 512;
  const requestedGpuBudgetMb =
    vramMb > 0
      ? Math.max(0, vramMb - Math.max(256, Math.min(4096, vramHeadroomMb)))
      : 0;
  const kvBytesPerTokenPerLayer = modelInfo?.kvBytesPerTokenPerLayer ?? 4096;
  const effectiveKvContextSize = getEffectiveKvContextSize(
    config.contextSize,
    modelInfo?.attentionSlidingWindow,
    modelInfo?.attentionSlidingWindowPattern,
    config.flashAttention,
  );
  const kvMbPerLayer =
    (Math.max(512, effectiveKvContextSize) * kvBytesPerTokenPerLayer) /
    (1024 * 1024);
  const autoPreviewGpuLayers =
    vramMb > 0
      ? Math.min(
          totalLayers,
          Math.floor(requestedGpuBudgetMb / (layerSizeMb + kvMbPerLayer)),
        )
      : 0;
  const manualPreviewGpuLayers =
    typeof config.manualGpuLayers === "number"
      ? Math.max(0, Math.min(totalLayers, config.manualGpuLayers))
      : autoPreviewGpuLayers;
  const previewGpuLayers =
    config.gpuLayersMode === "manual"
      ? manualPreviewGpuLayers
      : autoPreviewGpuLayers;
  const previewCpuLayers = Math.max(0, totalLayers - previewGpuLayers);
  const loadedGpuLayers = status?.gpuLayers ?? 0;
  const loadedTotalLayers = status?.totalLayers ?? totalLayers;
  const loadedCpuLayers = modelLoaded
    ? Math.max(0, loadedTotalLayers - loadedGpuLayers)
    : 0;
  const actualCtx = status?.actualContextSize ?? 0;
  const loadedBackendLabel =
    status?.backend === "tensorrt-native"
      ? "Native TensorRT"
      : status?.backend === "llama-cpp"
        ? "llama.cpp CUDA"
        : "No backend";
  const tensorCoreReady = Boolean(
    gpuInfo?.hasTensorCores && config.flashAttention,
  );
  const tensorCoreActive = Boolean(
    modelLoaded &&
    (status?.backend === "tensorrt-native" ||
      (tensorCoreReady && loadedGpuLayers > 0)),
  );
  const tensorRtRunnerAvailable = status?.tensorRtRunnerAvailable ?? false;
  const tensorRtRuntimeAvailable = status?.tensorRtRuntimeAvailable ?? false;
  const tensorRtRuntimePath = status?.tensorRtRuntimePath ?? "";
  const tensorRtEngineDir =
    config.tensorRtEngineDir ?? status?.tensorRtEngineDir ?? "";
  const tensorRtEngineFormat = status?.tensorRtEngineFormat ?? null;
  const usingTensorRt = config.inferenceBackend === "tensorrt-native";
  const tensorRtBuildRunning = tensorRtBuildStatus?.running ?? false;
  const tensorRtBuildPhase = tensorRtBuildStatus?.phase ?? "idle";
  const tensorRtBuildMessage =
    tensorRtBuildStatus?.message ??
    "No TensorRT-LLM engine build has been started.";
  const tensorRtLlmReady =
    tensorRtRunnerAvailable &&
    tensorRtRuntimeAvailable &&
    tensorRtEngineFormat === "tensorrt-llm";

  const modelWeightBudgetMb = previewGpuLayers * layerSizeMb;
  const kvBudgetMb = Math.max(0, requestedGpuBudgetMb - modelWeightBudgetMb);
  const selectedKvMb = previewGpuLayers * kvMbPerLayer;
  const maxFeasibleContext =
    previewGpuLayers > 0 && kvBudgetMb > 0
      ? getContextSizeForEffectiveKv(
          Math.floor(
            (kvBudgetMb * 1024 * 1024) /
              (kvBytesPerTokenPerLayer * previewGpuLayers),
          ),
          modelInfo?.attentionSlidingWindow,
          modelInfo?.attentionSlidingWindowPattern,
          config.flashAttention,
        )
      : 131072;
  const CONTEXT_STEP = 1024;
  const minContextSize = 2048;
  const modelMaxContextSize = Math.max(
    minContextSize,
    modelInfo?.contextLengthTrained ?? 131072,
  );
  const contextSliderValue = Math.min(config.contextSize, modelMaxContextSize);
  const maxFeasibleContextSnapped = Math.max(
    minContextSize,
    Math.min(
      modelMaxContextSize,
      Math.floor(maxFeasibleContext / CONTEXT_STEP) * CONTEXT_STEP,
    ),
  );
  const contextExceedsCurrentBudget = config.contextSize > maxFeasibleContext;
  const plannedGpuMemoryMb = modelWeightBudgetMb + selectedKvMb;
  const plannedSpareMb = Math.max(0, requestedGpuBudgetMb - plannedGpuMemoryMb);
  const maxLayersForSelectedContext =
    vramMb > 0
      ? Math.min(
          totalLayers,
          Math.floor(requestedGpuBudgetMb / (layerSizeMb + kvMbPerLayer)),
        )
      : 0;
  const applyBalancedAllocation = () => {
    const preferredContexts = [
      modelMaxContextSize,
      131072,
      65536,
      32768,
      16384,
    ].filter(
      (ctx, index, values) =>
        values.indexOf(ctx) === index && ctx <= modelMaxContextSize,
    );
    const pickedContext =
      preferredContexts.find((ctx) => {
        const effectiveCtx = getEffectiveKvContextSize(
          ctx,
          modelInfo?.attentionSlidingWindow,
          modelInfo?.attentionSlidingWindowPattern,
          config.flashAttention,
        );
        const kvForCtx =
          (Math.max(512, effectiveCtx) * kvBytesPerTokenPerLayer) /
          (1024 * 1024);
        const layers = Math.min(
          totalLayers,
          Math.floor(requestedGpuBudgetMb / (layerSizeMb + kvForCtx)),
        );
        return ctx >= 32768 && layers >= Math.floor(totalLayers * 0.65);
      }) ?? maxFeasibleContextSnapped;

    patch({
      gpuLayersMode: "auto",
      manualGpuLayers: null,
      contextSize: pickedContext,
      gpuMemoryUtilization: 0.98,
      vramHeadroomMb: 512,
      aggressiveMemory: true,
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-6 py-4 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Zap className="w-5 h-5 text-yellow-500" />
            Inference Engine
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Embedded tensor inference · node-llama-cpp · CUDA{" "}
            {gpuInfo?.tensorCoreGen ?? "—"}
          </p>
        </div>
        {modelLoaded ? (
          <div className="flex flex-col items-end gap-1">
            <span className="flex items-center gap-1.5 text-xs font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30 px-3 py-1.5 rounded-full border border-green-200 dark:border-green-800">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Active · {modelName}
            </span>
            <span className="text-[10px] text-muted-foreground px-1">
              {loadedGpuLayers} layers GPU · {loadedCpuLayers} CPU · ctx{" "}
              {actualCtx.toLocaleString()} tokens
            </span>
          </div>
        ) : (
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground bg-muted px-3 py-1.5 rounded-full border">
            <AlertCircle className="w-3.5 h-3.5" />
            No model loaded
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 max-w-7xl mx-auto w-full">
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px] items-start">
          <div className="space-y-5 min-w-0">
            <Section title="Runtime" icon={Zap}>
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    onClick={() => patch({ inferenceBackend: "llama-cpp" })}
                    className={cn(
                      "rounded-lg border px-4 py-3 text-left transition-colors",
                      !usingTensorRt
                        ? "border-primary bg-primary/10"
                        : "bg-background hover:bg-muted/50",
                    )}
                  >
                    <p className="text-sm font-semibold">llama.cpp CUDA</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      GGUF models with GPU layer offload, Flash Attention, and
                      CPU fallback.
                    </p>
                  </button>
                  <button
                    onClick={() =>
                      patch({ inferenceBackend: "tensorrt-native" })
                    }
                    className={cn(
                      "rounded-lg border px-4 py-3 text-left transition-colors",
                      usingTensorRt
                        ? "border-primary bg-primary/10"
                        : "bg-background hover:bg-muted/50",
                    )}
                  >
                    <p className="text-sm font-semibold">Native TensorRT</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Windows runner process for compiled TensorRT engines. No
                      WSL and no localhost service.
                    </p>
                  </button>
                </div>

                {usingTensorRt && (
                  <div className="rounded-lg border bg-background px-3 py-3 space-y-3">
                    {/* Runtime readiness row */}
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">
                          TensorRT-LLM Engine
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Python runner · TensorRT{" "}
                          {tensorRtRuntimeAvailable ? "✓" : "✗"} · Real
                          tokenizer + decode loop
                        </p>
                      </div>
                      <span
                        className={cn(
                          "text-[10px] px-2 py-0.5 rounded-full border shrink-0",
                          tensorRtLlmReady
                            ? "text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800"
                            : !tensorRtRuntimeAvailable
                              ? "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800"
                              : tensorRtEngineFormat === "tensorrt-plan"
                                ? "text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800"
                                : "text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800",
                        )}
                      >
                        {tensorRtLlmReady
                          ? "ready"
                          : !tensorRtRuntimeAvailable
                            ? "TensorRT not found"
                            : tensorRtEngineFormat === "tensorrt-plan"
                              ? "plan only — build LLM engine"
                              : tensorRtEngineFormat === "tensorrt-llm"
                                ? "engine found"
                                : "no engine"}
                      </span>
                    </div>

                    {/* Warnings */}
                    {!tensorRtRuntimeAvailable && (
                      <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                        TensorRT runtime not found. Set{" "}
                        <code className="font-mono">
                          TENSORRT_ROOT=C:\NVIDIA\TensorRT-10.16.1.11
                        </code>{" "}
                        and restart the app.
                      </div>
                    )}
                    {tensorRtEngineFormat === "tensorrt-plan" && (
                      <div className="rounded-lg bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 px-3 py-2 text-xs text-orange-700 dark:text-orange-300">
                        This directory contains a raw TensorRT plan (format:
                        tensorrt-plan). It cannot run LLM chat. Use the build
                        panel below to create a full TensorRT-LLM engine
                        instead.
                      </div>
                    )}

                    {/* Engine directory picker */}
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1.5">
                        Engine Directory
                        {tensorRtEngineFormat && (
                          <span className="ml-2 font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded">
                            {tensorRtEngineFormat}
                          </span>
                        )}
                      </p>
                      <div className="flex gap-2">
                        <div className="flex-1 border rounded-lg px-3 py-2 text-sm bg-background font-mono truncate text-muted-foreground min-w-0">
                          {tensorRtEngineDir || "No engine directory selected"}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleBrowseTensorRtEngine}
                        >
                          <FolderOpen className="w-4 h-4 mr-1.5" />
                          Browse
                        </Button>
                      </div>
                    </div>

                    {/* Build panel */}
                    <div className="rounded-lg border bg-muted/30 px-3 py-3 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">
                            Local One-Time Engine Build
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Downloads model from HuggingFace, exports ONNX,
                            compiles TensorRT-LLM engine on this PC. Engine is
                            reused on future launches.
                          </p>
                        </div>
                        <span
                          className={cn(
                            "text-[10px] px-2 py-0.5 rounded-full border shrink-0",
                            tensorRtBuildPhase === "done"
                              ? "text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800"
                              : tensorRtBuildPhase === "failed"
                                ? "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800"
                                : tensorRtBuildRunning
                                  ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800"
                                  : "text-muted-foreground bg-background",
                          )}
                        >
                          {tensorRtBuildRunning
                            ? "building…"
                            : tensorRtBuildPhase}
                        </span>
                      </div>

                      {/* Model selector */}
                      <div>
                        <label className="text-xs font-medium text-muted-foreground mb-1 block">
                          Model to build
                        </label>
                        <select
                          value={tensorRtBuildModelId}
                          onChange={(e) =>
                            setTensorRtBuildModelId(e.target.value)
                          }
                          disabled={tensorRtBuildRunning}
                          className="w-full border rounded-lg px-3 py-2 text-sm bg-background font-mono disabled:opacity-50"
                        >
                          <option value="Qwen/Qwen2.5-0.5B-Instruct">
                            Qwen2.5-0.5B-Instruct (~1 GB · fastest build)
                          </option>
                          <option value="Qwen/Qwen2.5-1.5B-Instruct">
                            Qwen2.5-1.5B-Instruct (~3 GB · recommended)
                          </option>
                          <option value="Qwen/Qwen2.5-3B-Instruct">
                            Qwen2.5-3B-Instruct (~6 GB)
                          </option>
                          <option value="Qwen/Qwen2.5-7B-Instruct">
                            Qwen2.5-7B-Instruct (~14 GB)
                          </option>
                        </select>
                        <p className="text-[10px] text-muted-foreground mt-1">
                          Start with 0.5B or 1.5B to verify the pipeline. Build
                          takes 10–40 min on first run.
                        </p>
                      </div>

                      {/* Status message */}
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-xs text-muted-foreground break-words min-w-0 font-mono">
                          {tensorRtBuildMessage}
                        </p>
                        {tensorRtBuildRunning ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleCancelTensorRtEngineBuild}
                            className="shrink-0"
                          >
                            Cancel
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleBuildTensorRtEngine}
                            disabled={!tensorRtRuntimeAvailable}
                            className="shrink-0"
                          >
                            <Wrench className="w-4 h-4 mr-1.5" />
                            Build
                          </Button>
                        )}
                      </div>
                    </div>

                    {tensorRtRuntimePath && (
                      <p className="text-[10px] text-muted-foreground font-mono truncate">
                        Runtime DLLs: {tensorRtRuntimePath}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </Section>

            {/* Model */}
            <Section title="Model" icon={Cpu} defaultOpen={!usingTensorRt}>
              <div className="space-y-4">
                {library.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-sm font-medium flex items-center gap-1.5">
                        <Database className="w-3.5 h-3.5 text-primary" />
                        From Library ({library.length})
                      </label>
                      <button
                        onClick={() => navigate({ to: "/marketplace" })}
                        className="text-xs text-primary hover:underline flex items-center gap-1"
                      >
                        <HardDrive className="w-3 h-3" />
                        Browse Marketplace
                      </button>
                    </div>
                    <select
                      value={
                        library.some((m) => m.filePath === config.modelPath)
                          ? config.modelPath
                          : ""
                      }
                      onChange={(e) => {
                        if (e.target.value) inspectFile(e.target.value);
                      }}
                      className="w-full border rounded-lg px-3 py-2 text-sm bg-background font-mono"
                    >
                      <option value="">— pick a downloaded model —</option>
                      {library.map((m) => (
                        <option key={m.filePath} value={m.filePath}>
                          {m.fileName} (
                          {(m.fileSizeBytes / 1024 ** 3).toFixed(2)} GB)
                          {m.repoId ? ` · ${m.repoId}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

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
                      disabled={isLoading || isInspecting}
                    >
                      {isInspecting ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
                          Scanning…
                        </>
                      ) : (
                        <>
                          <FolderOpen className="w-4 h-4 mr-1.5" />
                          Browse
                        </>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={refreshLibrary}
                    >
                      <RefreshCw className="w-4 h-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    Pick from your downloaded library above, or browse to any
                    GGUF anywhere on disk (e.g. an LM Studio folder).
                  </p>
                </div>

                {modelInfo && (
                  <div className="rounded-lg bg-muted/40 border px-4 py-3 space-y-2">
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-6 gap-y-1.5 text-sm">
                      <div>
                        <p className="text-xs text-muted-foreground">Arch</p>
                        <p className="font-medium font-mono">
                          {modelInfo.architecture ?? "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">
                          File size
                        </p>
                        <p className="font-medium">
                          {(modelInfo.fileSizeMb / 1024).toFixed(2)} GB
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">
                          Parameters
                        </p>
                        <p className="font-medium">
                          {modelInfo.paramBillions
                            ? `${modelInfo.paramBillions}B`
                            : "unknown"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">
                          Quantization
                        </p>
                        <p className="font-medium font-mono">
                          {modelInfo.quantization}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Layers</p>
                        <p className="font-medium">
                          {modelInfo.estimatedLayers}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-1.5 text-xs text-muted-foreground border-t border-dashed pt-2">
                      <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>
                        Safe GPU layers for your{" "}
                        {gpuInfo
                          ? `${(gpuInfo.vramMb / 1024).toFixed(0)} GB`
                          : ""}{" "}
                        VRAM:{" "}
                        <strong className="text-foreground">
                          {modelInfo.maxSafeGpuLayers}
                        </strong>{" "}
                        of {modelInfo.estimatedLayers} &nbsp;·&nbsp; ~
                        {modelInfo.layerSizeMb} MB/layer (loaded) &nbsp;·&nbsp;
                        Remaining{" "}
                        <strong className="text-foreground">
                          {previewCpuLayers}
                        </strong>{" "}
                        layers auto-offload to CPU RAM
                        {modelInfo.contextLengthTrained ? (
                          <>
                            &nbsp;·&nbsp; trained ctx{" "}
                            <strong className="text-foreground">
                              {(modelInfo.contextLengthTrained / 1024).toFixed(
                                0,
                              )}
                              K
                            </strong>
                          </>
                        ) : null}
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <Button
                    onClick={handleLoad}
                    disabled={
                      isLoading ||
                      (usingTensorRt ? !tensorRtEngineDir : !config.modelPath)
                    }
                    className="flex-1"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        Loading — may take 60–120 s…
                      </>
                    ) : (
                      <>
                        <Zap className="w-4 h-4 mr-2" />
                        {usingTensorRt ? "Load TensorRT Engine" : "Load Model"}
                      </>
                    )}
                  </Button>
                  {modelLoaded && (
                    <Button
                      variant="outline"
                      onClick={handleUnload}
                      disabled={isLoading}
                    >
                      <Power className="w-4 h-4 mr-1.5" />
                      Unload
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={refreshStatus}
                    title="Refresh"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </Section>

            {/* Memory & Compute */}
            <Section title="Memory & Compute" icon={Settings2}>
              <div className="space-y-6">
                <div className="space-y-3">
                  <div className="rounded-lg border bg-background px-3 py-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold flex items-center gap-1.5">
                          <Zap className="w-3.5 h-3.5 text-yellow-500" />
                          VRAM Budget
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Use {(requestedGpuBudgetMb / 1024).toFixed(1)} GB,
                          keep {(vramHeadroomMb / 1024).toFixed(1)} GB free
                        </p>
                      </div>
                      <span className="text-sm font-mono tabular-nums bg-muted px-2 py-0.5 rounded">
                        {vramHeadroomMb} MB
                      </span>
                    </div>
                    <input
                      type="range"
                      min={256}
                      max={2048}
                      step={128}
                      value={vramHeadroomMb}
                      onChange={(e) =>
                        patch({
                          vramHeadroomMb: Number(e.target.value),
                          gpuMemoryUtilization: 0.98,
                        })
                      }
                      className="w-full accent-primary h-1.5 cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>256 MB aggressive</span>
                      <span>512 MB fast</span>
                      <span>2 GB safe</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={applyBalancedAllocation}
                        disabled={!modelInfo || vramMb <= 0}
                      >
                        Balanced
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          patch({
                            contextSize: maxFeasibleContextSnapped,
                            gpuMemoryUtilization: 0.98,
                          })
                        }
                        disabled={!modelInfo || vramMb <= 0}
                      >
                        Fit Context
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          patch({
                            gpuLayersMode: "manual",
                            manualGpuLayers: maxLayersForSelectedContext,
                            gpuMemoryUtilization: 0.98,
                          })
                        }
                        disabled={!modelInfo || vramMb <= 0}
                      >
                        Max GPU
                      </Button>
                    </div>
                    <ToggleField
                      label="Exact Context Allocation"
                      checked={config.aggressiveMemory ?? true}
                      onChange={(v) => patch({ aggressiveMemory: v })}
                      hint="Requests the selected context exactly. If it cannot fit, the loader reduces GPU layers instead of silently shrinking context."
                    />
                  </div>

                  {modelInfo && (
                    <div className="rounded-lg border bg-background px-3 py-3 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">
                            Layer Placement
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {previewGpuLayers} of {totalLayers} layers on GPU,{" "}
                            {previewCpuLayers} on CPU
                          </p>
                        </div>
                        <div className="inline-flex rounded-md border overflow-hidden text-xs">
                          <button
                            onClick={() =>
                              patch({
                                gpuLayersMode: "auto",
                                manualGpuLayers: null,
                              })
                            }
                            className={cn(
                              "px-3 py-1.5",
                              config.gpuLayersMode !== "manual"
                                ? "bg-primary text-primary-foreground"
                                : "hover:bg-muted",
                            )}
                          >
                            Auto
                          </button>
                          <button
                            onClick={() =>
                              patch({
                                gpuLayersMode: "manual",
                                manualGpuLayers: previewGpuLayers,
                              })
                            }
                            className={cn(
                              "px-3 py-1.5 border-l",
                              config.gpuLayersMode === "manual"
                                ? "bg-primary text-primary-foreground"
                                : "hover:bg-muted",
                            )}
                          >
                            Manual
                          </button>
                        </div>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={totalLayers}
                        step={1}
                        value={previewGpuLayers}
                        disabled={config.gpuLayersMode !== "manual"}
                        onChange={(e) =>
                          patch({
                            gpuLayersMode: "manual",
                            manualGpuLayers: Number(e.target.value),
                          })
                        }
                        className="w-full accent-primary h-1.5 cursor-pointer disabled:opacity-50"
                      />
                      <div className="flex justify-between text-[10px] text-muted-foreground">
                        <span>0 GPU / {totalLayers} CPU</span>
                        <span>
                          Auto: {autoPreviewGpuLayers} GPU /{" "}
                          {totalLayers - autoPreviewGpuLayers} CPU
                        </span>
                        <span>{totalLayers} GPU / 0 CPU</span>
                      </div>
                    </div>
                  )}

                  {modelInfo && vramMb > 0 && (
                    <div className="rounded-lg bg-muted/40 border px-3 py-2.5 space-y-2.5 text-xs">
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                        <div className="text-center">
                          <p className="text-muted-foreground mb-0.5">
                            GPU Layers
                          </p>
                          <p className="font-bold text-primary text-sm">
                            {previewGpuLayers}
                          </p>
                          <p className="text-muted-foreground">
                            ~
                            {((previewGpuLayers * layerSizeMb) / 1024).toFixed(
                              1,
                            )}{" "}
                            GB VRAM weights
                          </p>
                        </div>
                        <div className="text-center border-x">
                          <p className="text-muted-foreground mb-0.5">
                            CPU Layers
                          </p>
                          <p className="font-bold text-sm">
                            {previewCpuLayers}
                          </p>
                          <p className="text-muted-foreground">
                            ~
                            {((previewCpuLayers * layerSizeMb) / 1024).toFixed(
                              1,
                            )}{" "}
                            GB RAM
                          </p>
                        </div>
                        <div className="text-center">
                          <p className="text-muted-foreground mb-0.5">
                            KV Cache Budget
                          </p>
                          <p
                            className={cn(
                              "font-bold text-sm",
                              kvBudgetMb < 1024
                                ? "text-yellow-600 dark:text-yellow-400"
                                : "",
                            )}
                          >
                            {(kvBudgetMb / 1024).toFixed(1)} GB
                          </p>
                          <p className="text-muted-foreground">
                            need ~{(selectedKvMb / 1024).toFixed(1)} GB · max ~
                            {maxFeasibleContextSnapped >= 1024
                              ? `${maxFeasibleContextSnapped / 1024}K`
                              : maxFeasibleContextSnapped}{" "}
                            ctx
                          </p>
                          {modelInfo.attentionSlidingWindow ? (
                            <p className="text-muted-foreground">
                              SWA effective{" "}
                              {(effectiveKvContextSize / 1024).toFixed(0)}K
                            </p>
                          ) : null}
                        </div>
                        <div className="text-center border-l">
                          <p className="text-muted-foreground mb-0.5">
                            Planned Spare
                          </p>
                          <p
                            className={cn(
                              "font-bold text-sm",
                              plannedSpareMb > 1024
                                ? "text-yellow-600 dark:text-yellow-400"
                                : "",
                            )}
                          >
                            {(plannedSpareMb / 1024).toFixed(1)} GB
                          </p>
                          <p className="text-muted-foreground">
                            after weights + KV
                          </p>
                        </div>
                      </div>
                      {kvBudgetMb < 1024 && (
                        <p className="text-yellow-600 dark:text-yellow-400 flex items-start gap-1 border-t border-dashed pt-2">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          Only {(kvBudgetMb / 1024).toFixed(1)} GB left for KV
                          cache. Move fewer layers to GPU or increase VRAM
                          headroom if context loading fails.
                        </p>
                      )}
                    </div>
                  )}

                  {modelLoaded && (
                    <div
                      className={cn(
                        "rounded-lg border px-3 py-2 text-xs flex items-start gap-2",
                        actualCtx < 16384
                          ? "bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-300"
                          : "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-300",
                      )}
                    >
                      {actualCtx < 16384 ? (
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      )}
                      <span>
                        Loaded: <strong>{loadedGpuLayers} GPU layers</strong> ·{" "}
                        <strong>{loadedCpuLayers} CPU layers</strong> · context{" "}
                        <strong>{actualCtx.toLocaleString()} tokens</strong>
                        {actualCtx < 16384 && (
                          <>
                            {" "}
                            &nbsp;·&nbsp;{" "}
                            <strong className="text-yellow-700 dark:text-yellow-400">
                              Context too small for app building.
                            </strong>{" "}
                            Dyad's system prompt needs ~30K–60K tokens. Use Max
                            Context or move fewer layers to GPU, then reload
                            with ≥ 32K.
                          </>
                        )}
                      </span>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <label className="text-sm font-medium flex items-center gap-1.5">
                      Context Size
                      {config.contextSize < 16384 && (
                        <span className="text-[10px] font-normal text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-1.5 py-0.5 rounded-full border border-red-200 dark:border-red-800">
                          too small for app building
                        </span>
                      )}
                    </label>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono tabular-nums bg-muted px-2 py-0.5 rounded">
                        {(contextSliderValue / 1024).toFixed(0)}K
                      </span>
                      {modelInfo && vramMb > 0 && (
                        <button
                          onClick={() =>
                            patch({ contextSize: maxFeasibleContextSnapped })
                          }
                          className="text-xs text-primary hover:underline flex items-center gap-1"
                        >
                          <Zap className="w-3 h-3" />
                          Fit VRAM (
                          {(maxFeasibleContextSnapped / 1024).toFixed(0)}K)
                        </button>
                      )}
                    </div>
                  </div>
                  {config.contextSize < 32768 && (
                    <div className="flex items-start gap-1.5 text-xs bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 text-orange-800 dark:text-orange-300 rounded-lg px-3 py-2">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>
                        <strong>App building needs ≥ 32K context.</strong>{" "}
                        Dyad's system prompt carries your app's source code —
                        typically 30K–60K tokens. Below 32K, the prompt gets
                        truncated and the model can barely generate a response.
                        Use Max Context or move fewer layers to GPU, then set
                        context to 32K.
                      </span>
                    </div>
                  )}
                  <div className="rounded-lg border bg-background px-3 py-3 space-y-2">
                    <input
                      type="range"
                      min={minContextSize}
                      max={modelMaxContextSize}
                      step={CONTEXT_STEP}
                      value={contextSliderValue}
                      onChange={(e) =>
                        patch({ contextSize: Number(e.target.value) })
                      }
                      className="w-full accent-primary h-1.5 cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>{(minContextSize / 1024).toFixed(0)}K</span>
                      <span>
                        VRAM fit {(maxFeasibleContextSnapped / 1024).toFixed(0)}
                        K
                      </span>
                      <span>
                        Model max {(modelMaxContextSize / 1024).toFixed(0)}K
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => patch({ contextSize: minContextSize })}
                      >
                        Min
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          patch({ contextSize: modelMaxContextSize })
                        }
                      >
                        Model Max
                      </Button>
                    </div>
                  </div>
                  {contextExceedsCurrentBudget && modelInfo && vramMb > 0 ? (
                    <div className="flex items-start gap-1.5 text-xs text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg px-3 py-2">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>
                        <strong>
                          {config.contextSize >= 1024
                            ? `${config.contextSize / 1024}K`
                            : config.contextSize}{" "}
                          tokens
                        </strong>{" "}
                        exceeds the current GPU-layer KV budget. Exact
                        allocation will try it first, then reduce GPU layers
                        before reducing context. Current layer budget fits ~
                        <strong>
                          {maxFeasibleContextSnapped >= 1024
                            ? `${maxFeasibleContextSnapped / 1024}K`
                            : maxFeasibleContextSnapped}
                        </strong>{" "}
                        tokens. Move fewer layers to GPU or reduce context.
                      </span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Slider maximum follows the selected model's GGUF trained
                      context. Exact allocation requests the selected context
                      directly; if VRAM is tight, reload reduces GPU layers
                      before reducing context.
                    </p>
                  )}
                </div>

                <NumberField
                  label="Batch Size"
                  value={config.batchSize}
                  min={64}
                  max={2048}
                  step={64}
                  onChange={(v) => patch({ batchSize: v })}
                  hint="Tokens per prefill step. 512 is a good default for Ada GPUs."
                />

                <ToggleField
                  label="Flash Attention"
                  checked={config.flashAttention}
                  onChange={(v) => patch({ flashAttention: v })}
                  hint="Fused attention — saves ~30% VRAM and speeds up long contexts. Requires CC ≥ 8.0 (your RTX 4080 Super = CC 8.9 ✓)."
                />
              </div>
            </Section>

            {/* Sampling */}
            <Section title="Sampling" icon={Activity} defaultOpen={false}>
              <div className="space-y-5">
                <SliderField
                  label="Temperature"
                  value={config.temperature}
                  min={0}
                  max={2}
                  step={0.05}
                  onChange={(v) => patch({ temperature: v })}
                  hint="0 = deterministic, 0.7 = balanced, 1.5+ = creative."
                />
                <SliderField
                  label="Top-P"
                  value={config.topP}
                  min={0.1}
                  max={1}
                  step={0.05}
                  onChange={(v) => patch({ topP: v })}
                  hint="Nucleus sampling. 0.95 is standard."
                />
                <SliderField
                  label="Top-K"
                  value={config.topK}
                  min={1}
                  max={200}
                  step={1}
                  onChange={(v) => patch({ topK: v })}
                  hint="Candidate token limit. 40 is standard for chat models."
                />
                <SliderField
                  label="Repeat Penalty"
                  value={config.repeatPenalty}
                  min={1}
                  max={2}
                  step={0.05}
                  onChange={(v) => patch({ repeatPenalty: v })}
                  hint="1.0 = off. 1.1 recommended for Qwen models."
                />
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Seed</label>
                  <input
                    type="number"
                    placeholder="Random (leave blank)"
                    value={config.seed ?? ""}
                    onChange={(e) =>
                      patch({
                        seed:
                          e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                    className="w-full border rounded-md px-3 py-1.5 text-sm bg-background font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    Fixed seed for reproducible outputs.
                  </p>
                </div>
              </div>
            </Section>

            <div className="flex justify-end pb-6">
              <Button
                variant="outline"
                onClick={async () => {
                  await ipc.embeddedModel.saveConfig(config);
                  showSuccess("Configuration saved");
                }}
              >
                Save Configuration
              </Button>
            </div>
          </div>

          <div className="space-y-5 xl:sticky xl:top-24 min-w-0">
            <Section title="Hardware" icon={HardDrive}>
              <div className="space-y-3">
                {gpuStats ? (
                  <VramBar
                    used={gpuStats.vramUsedMb}
                    total={gpuStats.vramTotalMb}
                    overflow={gpuStats.memoryOverflowMb}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    nvidia-smi not detected; live GPU stats are unavailable
                  </p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <StatCard
                    label="GPU Util"
                    value={gpuStats?.utilizationPercent.toFixed(0) ?? "—"}
                    unit="%"
                    icon={Activity}
                  />
                  <StatCard
                    label="Temp"
                    value={gpuStats?.temperatureC.toFixed(0) ?? "—"}
                    unit="°C"
                    icon={Thermometer}
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
                  <div
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-xs space-y-2",
                      gpuStats.memoryOverflowMb > 64
                        ? "border-red-500/40 bg-red-500/10 text-red-200"
                        : "bg-muted/30",
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold">VRAM Overflow</span>
                      <span className="font-mono font-bold">
                        {gpuStats.memoryOverflowMb > 64
                          ? formatMemoryMb(gpuStats.memoryOverflowMb)
                          : "None"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
                      <span>Dedicated used</span>
                      <span className="text-right font-mono text-foreground">
                        {formatMemoryMb(gpuStats.dedicatedMemoryUsedMb)}
                      </span>
                      <span>Shared system RAM</span>
                      <span
                        className={cn(
                          "text-right font-mono",
                          gpuStats.sharedSystemMemoryUsedMb > 64
                            ? "text-red-400"
                            : "text-foreground",
                        )}
                      >
                        {formatMemoryMb(gpuStats.sharedSystemMemoryUsedMb)}
                      </span>
                    </div>
                    {gpuStats.memoryOverflowMb > 64 && (
                      <p className="text-red-300">
                        Shared GPU memory is active. This can push model/KV
                        traffic through system RAM over PCIe and slow inference.
                      </p>
                    )}
                  </div>
                )}
                {gpuInfo && (
                  <div className="space-y-1.5 text-xs border-t pt-3">
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Backend</span>
                      <span className="font-medium text-right">
                        {loadedBackendLabel}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">
                        Tensor Cores
                      </span>
                      <span
                        className={cn(
                          "font-medium text-right",
                          tensorCoreActive
                            ? "text-green-600 dark:text-green-400"
                            : tensorCoreReady
                              ? "text-yellow-600 dark:text-yellow-400"
                              : "",
                        )}
                      >
                        {tensorCoreActive
                          ? "Active"
                          : tensorCoreReady
                            ? "Ready after GPU load"
                            : "Unavailable"}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">GPU</span>
                      <span className="font-medium text-right">
                        {gpuInfo.name}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">VRAM</span>
                      <span className="font-medium">
                        {(gpuInfo.vramMb / 1024).toFixed(1)} GB
                      </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Compute</span>
                      <span className="font-medium">
                        CC {gpuInfo.computeCapability.toFixed(1)} ·{" "}
                        {gpuInfo.tensorCoreGen}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </Section>

            <Section
              title="Inference Monitor"
              icon={Activity}
              defaultOpen={true}
            >
              <InferenceMonitor stats={inferenceStats} logs={logs} />
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
