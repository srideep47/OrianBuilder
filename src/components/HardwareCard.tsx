import { useEffect, useState } from "react";
import { ipc } from "@/ipc/types";
import type { HardwareProfile } from "@/ipc/types/hardware";
import type {
  OrchestratorStatus,
  AvailableTiers,
  MediaTier,
} from "@/ipc/types/model_orchestrator";
import {
  IMAGE_MODEL_TIERS,
  AUDIO_TTS_TIERS,
  VIDEO_TIERS,
} from "@/shared/media_tiers";
import { Cpu, RefreshCw, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const ORCH_STATE_STYLE: Record<OrchestratorStatus["state"], string> = {
  idle: "bg-muted text-muted-foreground border-muted-foreground/30",
  "llm-loading":
    "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-300 dark:border-blue-700",
  "llm-loaded":
    "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 border-green-300 dark:border-green-700",
  "swapping-out":
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300 border-yellow-300 dark:border-yellow-700",
  "media-loading":
    "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 border-orange-300 dark:border-orange-700",
  "media-loaded":
    "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 border-purple-300 dark:border-purple-700",
  "swapping-back":
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300 border-yellow-300 dark:border-yellow-700",
};

function MediaGenerationPanel() {
  const [tiers, setTiers] = useState<AvailableTiers | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const t = await ipc.orchestrator.getAvailableTiers();
        if (!cancelled) setTiers(t);
      } catch {
        /* main may not have registered yet */
      }
    };
    refresh();
    const id = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!tiers) return null;

  const renderRow = (all: readonly MediaTier[], fitting: MediaTier[]) => {
    const fittingIds = new Set(fitting.map((t) => t.id));
    const autoId = fitting[0]?.id;
    return all.map((t) => {
      const ok = fittingIds.has(t.id);
      const auto = t.id === autoId;
      return (
        <div
          key={t.id}
          className={cn(
            "flex items-center justify-between text-[11px] px-2 py-1 rounded",
            ok ? "" : "opacity-40",
          )}
        >
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-block w-1.5 h-1.5 rounded-full",
                ok ? "bg-green-500" : "bg-muted-foreground/40",
              )}
            />
            <span className="font-mono">{t.id}</span>
            {auto && (
              <span className="text-[9px] uppercase tracking-wider text-primary font-semibold">
                auto
              </span>
            )}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {t.vramRequiredMb === 0 ? "CPU OK" : `${t.vramRequiredMb} MB`}
          </span>
        </div>
      );
    });
  };

  return (
    <div className="border-t px-5 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          <Sparkles className="w-3 h-3" />
          Media Generation
        </div>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          Projected free VRAM: {tiers.projectedAvailableVramMb} MB
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
            Image
          </div>
          {renderRow(IMAGE_MODEL_TIERS, tiers.image)}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
            Audio TTS
          </div>
          {renderRow(AUDIO_TTS_TIERS, tiers.audio)}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
            Video
          </div>
          {renderRow(VIDEO_TIERS, tiers.video)}
        </div>
      </div>
    </div>
  );
}

function OrchestratorBadge() {
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await ipc.orchestrator.getStatus();
        if (!cancelled) setStatus(s);
      } catch {
        /* ignore — main may not have registered the handler yet */
      }
    };
    refresh();
    const id = setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!status) return null;
  return (
    <span
      className={cn(
        "px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide",
        ORCH_STATE_STYLE[status.state],
      )}
      title={
        status.currentLlmModel
          ? `LLM: ${status.currentLlmModel}`
          : "No LLM loaded"
      }
    >
      orch: {status.state}
    </span>
  );
}

const BACKEND_COLORS: Record<string, string> = {
  cuda: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 border-green-300 dark:border-green-700",
  rocm: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 border-red-300 dark:border-red-700",
  metal:
    "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 border-purple-300 dark:border-purple-700",
  vulkan:
    "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300 border-orange-300 dark:border-orange-700",
  directml:
    "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 border-blue-300 dark:border-blue-700",
  openvino:
    "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300 border-cyan-300 dark:border-cyan-700",
  cpu: "bg-muted text-muted-foreground border-muted-foreground/30",
};

function BackendBadge({
  name,
  highlighted,
}: {
  name: string;
  highlighted?: boolean;
}) {
  return (
    <span
      className={cn(
        "px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide",
        BACKEND_COLORS[name] ?? BACKEND_COLORS.cpu,
        highlighted && "ring-2 ring-offset-1 ring-primary",
      )}
    >
      {name}
    </span>
  );
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb > 0) return `${mb} MB`;
  return "—";
}

export function HardwareCard() {
  const [profile, setProfile] = useState<HardwareProfile | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await ipc.hardware.getProfile();
        if (!cancelled) setProfile(p);
      } catch (err) {
        console.error("Failed to load hardware profile:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const p = await ipc.hardware.refreshProfile();
      setProfile(p);
    } finally {
      setRefreshing(false);
    }
  };

  if (!profile) {
    return (
      <div className="rounded-xl border bg-card p-5 flex items-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Detecting hardware…
      </div>
    );
  }

  const primary = profile.primaryGpu;

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className="px-5 py-3.5 flex items-center justify-between border-b">
        <div className="flex items-center gap-2.5 font-semibold text-sm">
          <Cpu className="w-4 h-4 text-primary" />
          Hardware
          <OrchestratorBadge />
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} />
          Refresh
        </button>
      </div>
      <div className="px-5 py-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
            Primary GPU
          </div>
          <div
            className="font-semibold text-sm truncate"
            title={primary?.model}
          >
            {primary?.model ?? "No discrete GPU"}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="capitalize">{primary?.vendor ?? "—"}</span>
            <span>·</span>
            <span>{formatMb(primary?.vramMb ?? 0)} VRAM</span>
            {primary?.isIntegrated && (
              <span className="px-1.5 py-0.5 rounded bg-muted text-[10px]">
                integrated
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground pt-1">
            CPU: {profile.cpu.model} ({profile.cpu.logicalCores} threads)
          </div>
          <div className="text-xs text-muted-foreground">
            RAM: {formatMb(profile.totalRamMb)} · {profile.os} / {profile.arch}
          </div>
        </div>

        <div className="space-y-3 min-w-0">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">
              Detected backends
            </div>
            <div className="flex flex-wrap gap-1.5">
              {profile.availableBackends.map((b) => (
                <BackendBadge
                  key={b}
                  name={b}
                  highlighted={
                    b === profile.bestLlmBackend ||
                    b === profile.bestMediaBackend
                  }
                />
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Best LLM
              </div>
              <div className="font-semibold uppercase">
                {profile.bestLlmBackend}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Best Media
              </div>
              <div className="font-semibold uppercase">
                {profile.bestMediaBackend}
              </div>
            </div>
          </div>
        </div>
      </div>
      <MediaGenerationPanel />
    </div>
  );
}
