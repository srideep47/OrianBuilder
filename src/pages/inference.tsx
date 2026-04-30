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
          className={cn(
            "h-full rounded-full transition-all duration-500",
            color,
          )}
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
            <SpeedMetric label="Avg" value={stats?.avgTps ?? 0} />
            <SpeedMetric label="Peak" value={stats?.peakTps ?? 0} />
            <SpeedMetric label="Low" value={stats?.lowestTps ?? 0} />
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
              <span className="text-muted-foreground">Tokens out </span>
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
              <span className="text-muted-foreground">Sessions </span>
              <span className="font-bold tabular-nums">
                {stats?.totalSessions ?? 0}
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
  gpuMemoryUtilization: 0.8,
  contextSize: 8192,
  batchSize: 512,
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  repeatPenalty: 1.1,
  seed: null,
  flashAttention: true,
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
          gpuMemoryUtilization: 0.8,
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
      const [gpu, s, cfg, lib, recentLogs] = await Promise.all([
        ipc.embeddedModel.detectGpu(undefined),
        ipc.embeddedModel.getStatus(),
        ipc.embeddedModel.getSavedConfig(),
        ipc.marketplace.listLocalModels(),
        ipc.embeddedModel.getRecentLogs(),
      ]);
      setGpuInfo(gpu);
      setStatus(s);
      setLibrary(lib);
      setLogs(recentLogs);
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
    return () => {
      unsubStats();
      unsubLog();
    };
  }, []);

  const handleBrowse = async () => {
    const path = await ipc.embeddedModel.selectGguf();
    if (path) await inspectFile(path);
  };

  const handleLoad = async () => {
    if (!config.modelPath) {
      showError("Select a GGUF file first");
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
  const previewGpuLayers =
    vramMb > 0
      ? Math.min(
          totalLayers,
          Math.floor((vramMb * config.gpuMemoryUtilization) / layerSizeMb),
        )
      : 0;
  const previewCpuLayers = Math.max(0, totalLayers - previewGpuLayers);
  const loadedGpuLayers = status?.gpuLayers ?? 0;
  const loadedCpuLayers = modelLoaded
    ? Math.max(0, totalLayers - loadedGpuLayers)
    : 0;
  const actualCtx = status?.actualContextSize ?? 0;

  const kvBudgetMb = Math.max(0, vramMb - previewGpuLayers * layerSizeMb);
  const kvBytesPerTokenPerLayer = modelInfo?.kvBytesPerTokenPerLayer ?? 4096;
  const maxFeasibleContext =
    previewGpuLayers > 0 && kvBudgetMb > 0
      ? Math.floor(
          (kvBudgetMb * 1024 * 1024) /
            (kvBytesPerTokenPerLayer * previewGpuLayers),
        )
      : 131072;
  const CTX_OPTIONS = [2048, 4096, 8192, 16384, 32768, 65536, 131072];
  const maxFeasibleContextSnapped = CTX_OPTIONS.reduce(
    (best, v) => (v <= maxFeasibleContext ? v : best),
    2048,
  );
  const contextWillAutoReduce = config.contextSize > maxFeasibleContext;

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

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 max-w-4xl mx-auto w-full">
        {/* Live Stats */}
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
          {gpuStats ? (
            <VramBar used={gpuStats.vramUsedMb} total={gpuStats.vramTotalMb} />
          ) : (
            <p className="text-xs text-muted-foreground">
              nvidia-smi not detected — GPU stats unavailable
            </p>
          )}
        </Section>

        {/* GPU Info */}
        <Section title="GPU Detection" icon={HardDrive} defaultOpen={false}>
          {gpuInfo ? (
            <div className="grid grid-cols-2 gap-x-8 text-sm">
              {[
                ["GPU", gpuInfo.name],
                ["VRAM", `${(gpuInfo.vramMb / 1024).toFixed(1)} GB`],
                ["Compute Capability", gpuInfo.computeCapability.toFixed(1)],
                [
                  "Tensor Cores",
                  gpuInfo.hasTensorCores
                    ? `${gpuInfo.tensorCoreGen} ✓`
                    : "Not available",
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
            <p className="text-sm text-muted-foreground">Detecting…</p>
          )}
        </Section>

        {/* Model */}
        <Section title="Model" icon={Cpu}>
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
                      {m.fileName} ({(m.fileSizeBytes / 1024 ** 3).toFixed(2)}{" "}
                      GB)
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
                <Button variant="outline" size="sm" onClick={refreshLibrary}>
                  <RefreshCw className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                Pick from your downloaded library above, or browse to any GGUF
                anywhere on disk (e.g. an LM Studio folder).
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
                    <p className="text-xs text-muted-foreground">File size</p>
                    <p className="font-medium">
                      {(modelInfo.fileSizeMb / 1024).toFixed(2)} GB
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Parameters</p>
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
                    <p className="font-medium">{modelInfo.estimatedLayers}</p>
                  </div>
                </div>
                <div className="flex items-start gap-1.5 text-xs text-muted-foreground border-t border-dashed pt-2">
                  <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    Safe GPU layers for your{" "}
                    {gpuInfo ? `${(gpuInfo.vramMb / 1024).toFixed(0)} GB` : ""}{" "}
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
                          {(modelInfo.contextLengthTrained / 1024).toFixed(0)}K
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
                disabled={isLoading || !config.modelPath}
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
                    Load Model
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

        {/* Inference Monitor */}
        <Section title="Inference Monitor" icon={Activity} defaultOpen={true}>
          <InferenceMonitor stats={inferenceStats} logs={logs} />
        </Section>

        {/* Memory & Compute */}
        <Section title="Memory & Compute" icon={Settings2}>
          <div className="space-y-6">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <label className="text-sm font-semibold flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-yellow-500" />
                    GPU Memory Utilization
                  </label>
                  <span className="text-sm font-mono tabular-nums bg-muted px-2 py-0.5 rounded">
                    {(config.gpuMemoryUtilization * 100).toFixed(0)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.4}
                  max={0.92}
                  step={0.02}
                  value={config.gpuMemoryUtilization}
                  onChange={(e) =>
                    patch({ gpuMemoryUtilization: parseFloat(e.target.value) })
                  }
                  className="w-full accent-primary h-1.5 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>40% (safe)</span>
                  <span>80% (recommended)</span>
                  <span>92% (max)</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Fraction of VRAM used for model weights (same as vLLM's{" "}
                  <code className="font-mono text-[11px] bg-muted px-1 rounded">
                    gpu_memory_utilization
                  </code>
                  ). Remaining VRAM goes to KV cache. If you get OOM errors,
                  lower this.
                </p>
              </div>

              {modelInfo && vramMb > 0 && (
                <div className="rounded-lg bg-muted/40 border px-3 py-2.5 space-y-2.5 text-xs">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="text-center">
                      <p className="text-muted-foreground mb-0.5">GPU Layers</p>
                      <p className="font-bold text-primary text-sm">
                        {previewGpuLayers}
                      </p>
                      <p className="text-muted-foreground">
                        ~{((previewGpuLayers * layerSizeMb) / 1024).toFixed(1)}{" "}
                        GB VRAM
                      </p>
                    </div>
                    <div className="text-center border-x">
                      <p className="text-muted-foreground mb-0.5">CPU Layers</p>
                      <p className="font-bold text-sm">{previewCpuLayers}</p>
                      <p className="text-muted-foreground">
                        ~{((previewCpuLayers * layerSizeMb) / 1024).toFixed(1)}{" "}
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
                        max ~
                        {maxFeasibleContextSnapped >= 1024
                          ? `${maxFeasibleContextSnapped / 1024}K`
                          : maxFeasibleContextSnapped}{" "}
                        ctx
                      </p>
                    </div>
                  </div>
                  {kvBudgetMb < 1024 && (
                    <p className="text-yellow-600 dark:text-yellow-400 flex items-start gap-1 border-t border-dashed pt-2">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      Only {(kvBudgetMb / 1024).toFixed(1)} GB left for KV cache
                      — context will be very limited. Lower GPU utilization to
                      free up VRAM for larger context.
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
                        Dyad's system prompt needs ~30K–60K tokens. Lower GPU
                        utilization to free VRAM for a larger context, or reload
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
                {modelInfo && vramMb > 0 && (
                  <button
                    onClick={() =>
                      patch({ contextSize: maxFeasibleContextSnapped })
                    }
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    <Zap className="w-3 h-3" />
                    Set Max (
                    {maxFeasibleContextSnapped >= 1024
                      ? `${maxFeasibleContextSnapped / 1024}K`
                      : maxFeasibleContextSnapped}{" "}
                    tokens)
                  </button>
                )}
              </div>
              {config.contextSize < 32768 && (
                <div className="flex items-start gap-1.5 text-xs bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 text-orange-800 dark:text-orange-300 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    <strong>App building needs ≥ 32K context.</strong> Dyad's
                    system prompt carries your app's source code — typically
                    30K–60K tokens. Below 32K, the prompt gets truncated and the
                    model can barely generate a response. Lower GPU utilization
                    to free VRAM for KV cache, then set context to 32K.
                  </span>
                </div>
              )}
              <div className="grid grid-cols-4 gap-2">
                {CTX_OPTIONS.map((v) => {
                  const fits =
                    !modelInfo || vramMb === 0 || v <= maxFeasibleContext;
                  const tooSmall = v < 16384;
                  return (
                    <button
                      key={v}
                      onClick={() => patch({ contextSize: v })}
                      className={cn(
                        "rounded-lg border px-2 py-2 text-xs font-mono font-medium transition-colors relative",
                        config.contextSize === v
                          ? "bg-primary text-primary-foreground border-primary"
                          : fits && !tooSmall
                            ? "bg-background hover:bg-muted"
                            : tooSmall
                              ? "bg-background hover:bg-muted border-red-300/50 text-muted-foreground"
                              : "bg-background hover:bg-muted border-yellow-400/50 text-muted-foreground",
                      )}
                      title={
                        !fits
                          ? `Exceeds KV cache budget — auto-reduced to ~${maxFeasibleContextSnapped >= 1024 ? `${maxFeasibleContextSnapped / 1024}K` : maxFeasibleContextSnapped}`
                          : tooSmall
                            ? "Too small for Dyad app building (needs ≥ 32K)"
                            : undefined
                      }
                    >
                      {v >= 1024 ? `${v / 1024}K` : v}
                      {!fits && (
                        <span className="absolute -top-1 -right-1 text-yellow-500 text-[9px]">
                          ⚠
                        </span>
                      )}
                      {fits && tooSmall && config.contextSize !== v && (
                        <span className="absolute -top-1 -right-1 text-red-500 text-[9px]">
                          ✗
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {contextWillAutoReduce && modelInfo && vramMb > 0 ? (
                <div className="flex items-start gap-1.5 text-xs text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>
                    <strong>
                      {config.contextSize >= 1024
                        ? `${config.contextSize / 1024}K`
                        : config.contextSize}{" "}
                      tokens
                    </strong>{" "}
                    won't fit with current GPU settings. node-llama-cpp will
                    auto-reduce to ~
                    <strong>
                      {maxFeasibleContextSnapped >= 1024
                        ? `${maxFeasibleContextSnapped / 1024}K`
                        : maxFeasibleContextSnapped}
                    </strong>{" "}
                    tokens. Lower GPU utilization to free VRAM for KV cache.
                  </span>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Desired maximum — node-llama-cpp auto-scales down if VRAM is
                  tight. ⚠ = exceeds KV budget. ✗ = too small for app building.
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
                    seed: e.target.value === "" ? null : Number(e.target.value),
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
    </div>
  );
}
