import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import {
  CheckCircle2,
  ChevronDown,
  Cpu,
  Download,
  FileAudio,
  HardDrive,
  Image,
  Loader2,
  Mic,
  Music,
  Pause,
  Play,
  RefreshCw,
  Search,
  Send,
  Server,
  ServerOff,
  Settings2,
  Sparkles,
  Square,
  Terminal,
  Upload,
  Video,
  Wrench,
  Zap,
} from "lucide-react";
import {
  ipc,
  type AvailableTiers,
  type HardwareProfile,
  type MediaAiModelId,
  type MediaAiStatus,
  type MediaTier,
  type OrchestratorStatus,
} from "@/ipc/types";
import {
  USER_FACING_IMAGE_TIERS,
  type ImageTierUiConfig,
} from "@/shared/media_tiers";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type MediaTab = "image" | "audio" | "transcribe" | "video" | "music";

interface ItunesTrack {
  trackId: number;
  trackName: string;
  artistName: string;
  collectionName: string;
  artworkUrl100: string;
  previewUrl: string;
  primaryGenreName: string;
}

interface MusicTierInfo {
  id: string;
  label: string;
  description: string;
  vram_mb: number;
  download_size_mb: number;
  backends: string[];
  uses_lm: boolean;
  repo_url: string;
  available_for_backend: boolean;
  status: "downloaded" | "downloading" | "not_downloaded";
  download_progress?: number;
  selected: boolean;
}

const MUSIC_TIER_CATALOG: MusicTierInfo[] = [
  {
    id: "ace-step-turbo-4gb",
    label: "ACE-Step 1.5 Turbo (4 GB)",
    description:
      "Low-VRAM DiT-only model for full songs with vocals and instruments. Best first download for testing on 4 GB GPUs.",
    vram_mb: 4000,
    download_size_mb: 8500,
    backends: ["cuda", "rocm", "mps", "metal", "cpu"],
    uses_lm: false,
    repo_url: "https://github.com/ace-step/ACE-Step-1.5",
    available_for_backend: true,
    status: "not_downloaded",
    selected: true,
  },
  {
    id: "ace-step-xl-turbo-12gb",
    label: "ACE-Step 1.5 XL Turbo (12 GB)",
    description:
      "Higher fidelity 4B DiT tier with the 0.6B planner enabled for stronger structure and prompt adherence.",
    vram_mb: 12000,
    download_size_mb: 14000,
    backends: ["cuda", "rocm", "mps", "metal", "cpu"],
    uses_lm: true,
    repo_url: "https://github.com/ace-step/ACE-Step-1.5",
    available_for_backend: true,
    status: "not_downloaded",
    selected: false,
  },
];

interface GenerationResult {
  tab: MediaTab;
  content?: string;
  url?: string;
  // When set, the renderer uses this URL directly (no server prefix). Used by
  // cloud image sources like Pollinations.ai.
  absoluteUrl?: string;
  // Video-as-slideshow frames (cloud video). Renderer cycles them to simulate
  // motion when a true text-to-video model isn't available.
  frames?: string[];
  filename?: string;
  source?: "cloud" | "local";
}

const BACKEND_LABELS: Record<string, string> = {
  cuda: "CUDA",
  rocm: "ROCm",
  metal: "Metal",
  mps: "MPS",
  directml: "DirectML",
  openvino: "OpenVINO",
  vulkan: "Vulkan",
  cpu: "CPU",
};

const BACKEND_COLORS: Record<string, string> = {
  cuda: "bg-green-500/15 text-green-700 border-green-500/30",
  rocm: "bg-orange-500/15 text-orange-700 border-orange-500/30",
  metal: "bg-purple-500/15 text-purple-700 border-purple-500/30",
  mps: "bg-purple-500/15 text-purple-700 border-purple-500/30",
  directml: "bg-blue-500/15 text-blue-700 border-blue-500/30",
  openvino: "bg-sky-500/15 text-sky-700 border-sky-500/30",
  vulkan: "bg-red-500/15 text-red-700 border-red-500/30",
  cpu: "bg-muted text-muted-foreground border-border",
};

function BackendBadge({ backend }: { backend: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium",
        BACKEND_COLORS[backend] ?? BACKEND_COLORS.cpu,
      )}
    >
      {BACKEND_LABELS[backend] ?? backend.toUpperCase()}
    </span>
  );
}

function TierBadge({ tier }: { tier: MediaTier | null }) {
  if (!tier)
    return (
      <span className="text-xs text-muted-foreground">No model available</span>
    );
  const colorMap: Record<string, string> = {
    ultra: "bg-violet-500/15 text-violet-700 border-violet-500/30",
    best: "bg-green-500/15 text-green-700 border-green-500/30",
    good: "bg-blue-500/15 text-blue-700 border-blue-500/30",
    basic: "bg-yellow-500/15 text-yellow-700 border-yellow-500/30",
    slow: "bg-muted text-muted-foreground border-border",
  };
  const display = tier.label ?? tier.id;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium",
        colorMap[tier.quality] ?? colorMap.slow,
      )}
      title={`${tier.id} · ${tier.quality} · needs ${tier.vramRequiredMb} MB VRAM`}
    >
      {display} · {tier.quality}
    </span>
  );
}

// Pollinations.ai — free public text-to-image service. No auth, no key. Used as
// a cloud fallback for image/video so users don't have to set up the broken
// Python ONNX pipeline (Python 3.14 + Windows path issues).
//
// IMPORTANT: Pollinations now requires a `referrer` query param to identify
// the calling app. Without it the API returns HTTP 403 for fetch() callers
// (this is their app-identifier system, not auth — any string works).
const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt";
const POLLINATIONS_REFERRER = "orianbuilder";

function assertMediaAiOperationSucceeded(
  result: { success: boolean; output?: string },
  fallbackMessage: string,
): void {
  if (result.success) return;
  const details = result.output?.trim();
  throw new Error(details || fallbackMessage);
}

function pollinationsUrl(
  prompt: string,
  opts: { width?: number; height?: number; seed?: number; model?: string } = {},
): string {
  const seed = opts.seed ?? Math.floor(Math.random() * 1_000_000);
  const params = new URLSearchParams({
    width: String(opts.width ?? 768),
    height: String(opts.height ?? 768),
    seed: String(seed),
    nologo: "true",
    model: opts.model ?? "flux",
    referrer: POLLINATIONS_REFERRER,
  });
  return `${POLLINATIONS_BASE}/${encodeURIComponent(prompt)}?${params}`;
}

type ImageSettings = {
  width: number;
  height: number;
  steps: number;
  guidance: number;
  seed: number | null; // null = random each time
};
type EventLogEntry = {
  id: number;
  time: string;
  message: string;
  level: "info" | "error" | "success";
};

// Phase drives the setup banner UI. 'checking' = initial load, transitions based on status.
type SetupPhase =
  | "checking" // waiting for first status response
  | "stopped" // venv exists, backend not running — user must press Start
  | "needs-setup" // no venv, waiting for user to click
  | "python-missing" // python not in PATH
  | "setting-up" // setup chain running (install → download → start)
  | "starting" // backend was just started, polling until healthy
  | "stopping" // backend stop in flight
  | "online" // backend healthy
  | "error"; // unrecoverable error

const TIER_PREF_KEY = "mediaai:image:tier";
const SETTINGS_KEY = "mediaai:image:settings-by-tier";
const MUSIC_TIER_PREF_KEY = "mediaai:music:tier";

function loadStoredTierId(): string {
  if (typeof window === "undefined") return USER_FACING_IMAGE_TIERS[0].tierId;
  const v = window.localStorage.getItem(TIER_PREF_KEY);
  if (v && USER_FACING_IMAGE_TIERS.some((t) => t.tierId === v)) return v;
  return USER_FACING_IMAGE_TIERS[0].tierId;
}

function loadStoredMusicTierId(): string {
  if (typeof window === "undefined") return "ace-step-turbo-4gb";
  const value = window.localStorage.getItem(MUSIC_TIER_PREF_KEY);
  if (value && MUSIC_TIER_CATALOG.some((tier) => tier.id === value)) {
    return value;
  }
  return "ace-step-turbo-4gb";
}

function loadStoredSettings(): Record<string, ImageSettings> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, ImageSettings>) : {};
  } catch {
    return {};
  }
}

function defaultSettingsFor(tier: ImageTierUiConfig): ImageSettings {
  return {
    width: tier.defaultWidth,
    height: tier.defaultHeight,
    steps: tier.defaultSteps,
    guidance: tier.defaultGuidance,
    seed: null,
  };
}

export default function MediaAIPage() {
  const [activeTab, setActiveTab] = useState<MediaTab>("image");
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [status, setStatus] = useState<MediaAiStatus | null>(null);
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [orchStatus, setOrchStatus] = useState<OrchestratorStatus | null>(null);
  const [availTiers, setAvailTiers] = useState<AvailableTiers | null>(null);
  const [setupAction, setSetupAction] = useState<string | null>(null);
  const [setupChainStep, setSetupChainStep] = useState<string | null>(null);
  // Which model group inside the "download" step is currently being fetched.
  // null means no download active (or step is "install" / "start").
  const [setupChainModelId, setSetupChainModelId] =
    useState<MediaAiModelId | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  // Hardware as seen by the Python backend (may differ from Electron's view
  // if the backend started before CUDA detection finished).
  const [backendHardware, setBackendHardware] = useState<{
    backend: string;
    torch_device: string;
    vram_mb: number;
  } | null>(null);

  const [setupPhase, setSetupPhase] = useState<SetupPhase>("checking");
  const [setupError, setSetupError] = useState<string | null>(null);

  // Image-tier picker + per-tier persisted resolution/steps.
  const [selectedImageTierId, setSelectedImageTierId] = useState<string>(() =>
    loadStoredTierId(),
  );
  const [imageSettingsByTier, setImageSettingsByTier] = useState<
    Record<string, ImageSettings>
  >(() => loadStoredSettings());
  const [showImageSettings, setShowImageSettings] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const eventLogIdRef = useRef(0);
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);

  // Abort controller for in-flight generation fetches (used by Stop button)
  const abortRef = useRef<AbortController | null>(null);

  // Music tab sub-mode
  const [musicMode, setMusicMode] = useState<"generate" | "search">("generate");

  // AI music generation state
  const [musicGenPrompt, setMusicGenPrompt] = useState("");
  const [musicGenDuration, setMusicGenDuration] = useState(15);
  const [musicGenStatus, setMusicGenStatus] = useState<
    "idle" | "generating" | "done" | "error"
  >("idle");
  const [musicGenError, setMusicGenError] = useState("");
  const [musicGenAudioUrl, setMusicGenAudioUrl] = useState<string | null>(null);
  const musicGenAbortRef = useRef<AbortController | null>(null);

  const [musicTiers, setMusicTiers] = useState<MusicTierInfo[]>([]);
  const [musicTiersLoading, setMusicTiersLoading] = useState(false);
  const [selectedMusicTierId, setSelectedMusicTierId] = useState<string | null>(
    () => loadStoredMusicTierId(),
  );
  const [musicSetupRunning, setMusicSetupRunning] = useState(false);
  const [musicDownloadTierId, setMusicDownloadTierId] = useState<string | null>(
    null,
  );
  const [musicGeneratedTier, setMusicGeneratedTier] = useState<string | null>(
    null,
  );
  const musicDownloadPollRef = useRef<number | null>(null);

  // Music search state
  const [musicQuery, setMusicQuery] = useState("");
  const [musicResults, setMusicResults] = useState<ItunesTrack[]>([]);
  const [musicSearching, setMusicSearching] = useState(false);
  const [musicSearchError, setMusicSearchError] = useState("");
  const [playingTrackId, setPlayingTrackId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const selectedImageTier =
    USER_FACING_IMAGE_TIERS.find((t) => t.tierId === selectedImageTierId) ??
    USER_FACING_IMAGE_TIERS[0];
  const imageSettings: ImageSettings =
    imageSettingsByTier[selectedImageTier.tierId] ??
    defaultSettingsFor(selectedImageTier);

  const persistImageSettings = useCallback(
    (tierId: string, patch: Partial<ImageSettings>) => {
      setImageSettingsByTier((prev) => {
        const base =
          prev[tierId] ??
          defaultSettingsFor(
            USER_FACING_IMAGE_TIERS.find((t) => t.tierId === tierId) ??
              USER_FACING_IMAGE_TIERS[0],
          );
        const next = { ...prev, [tierId]: { ...base, ...patch } };
        try {
          window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
        } catch {
          // localStorage may be unavailable / full — non-fatal.
        }
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(TIER_PREF_KEY, selectedImageTierId);
    } catch {
      // non-fatal
    }
  }, [selectedImageTierId]);

  useEffect(() => {
    if (!selectedMusicTierId) return;
    try {
      window.localStorage.setItem(MUSIC_TIER_PREF_KEY, selectedMusicTierId);
    } catch {
      // non-fatal
    }
  }, [selectedMusicTierId]);

  const appendLog = useCallback(
    (message: string, level: EventLogEntry["level"] = "info") => {
      eventLogIdRef.current += 1;
      const entry: EventLogEntry = {
        id: eventLogIdRef.current,
        time: new Date().toLocaleTimeString(),
        message,
        level,
      };
      setEventLog((prev) => [...prev.slice(-49), entry]);
    },
    [],
  );

  // Audio transcription
  const [transcribeFile, setTranscribeFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const serverUrl = status?.serverUrl ?? "http://127.0.0.1:8000";
  const isBackendOnline = status?.healthy === true;
  const musicModelTiers =
    musicTiers.length > 0
      ? MUSIC_TIER_CATALOG.map(
          (catalogTier) =>
            musicTiers.find((tier) => tier.id === catalogTier.id) ??
            catalogTier,
        )
      : MUSIC_TIER_CATALOG;
  const selectedMusicTier =
    musicModelTiers.find((tier) => tier.id === selectedMusicTierId) ??
    musicModelTiers.find((tier) => tier.selected) ??
    musicModelTiers[0] ??
    null;

  const refreshAll = useCallback(async () => {
    const [nextStatus, nextHardware, nextOrch] = await Promise.all([
      ipc.mediaAi.getStatus(undefined),
      ipc.hardware.getProfile(undefined).catch(() => null),
      ipc.orchestrator.getStatus(undefined).catch(() => null),
    ]);
    setStatus(nextStatus);
    if (nextHardware) setHardware(nextHardware);
    if (nextOrch) setOrchStatus(nextOrch);

    if (nextStatus?.healthy) {
      const tiers = await ipc.orchestrator
        .getAvailableTiers(undefined)
        .catch(() => null);
      if (tiers) setAvailTiers(tiers);

      // Probe what the Python process actually sees for hardware — this
      // catches the case where the env var was "cpu" at startup but CUDA
      // was auto-promoted inside the process.
      fetch(`${nextStatus.serverUrl}/v1/hardware`)
        .then((r) => r.json())
        .then((data) =>
          setBackendHardware(
            data as { backend: string; torch_device: string; vram_mb: number },
          ),
        )
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    const interval = setInterval(() => void refreshAll(), 30000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  useEffect(() => {
    return () => {
      if (musicDownloadPollRef.current !== null) {
        window.clearInterval(musicDownloadPollRef.current);
        musicDownloadPollRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!status) return;

    if (status.healthy) {
      setSetupPhase("online");
      return;
    }

    // Backend not online — show correct idle state.
    // Allow from "checking" (initial load), "online" (backend just stopped/crashed),
    // "stopping" (stop completed), or "error" (previous attempt failed).
    // Never interrupt "setting-up" or "starting" — those manage phase themselves.
    const canTransition =
      setupPhase === "checking" ||
      setupPhase === "online" ||
      setupPhase === "stopping" ||
      setupPhase === "error";
    if (status.venvExists) {
      if (canTransition) setSetupPhase("stopped");
    } else if (canTransition) {
      setSetupPhase("needs-setup");
    }
  }, [status]); // intentionally omits setupPhase — reads snapshot at render time

  const runSetupAction = async (
    actionName: string,
    action: () => Promise<void>,
  ) => {
    setSetupAction(actionName);
    try {
      await action();
      await refreshAll();
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSetupAction(null);
    }
  };

  const tierDownloaded = useCallback(
    (downloadId: string): boolean =>
      status?.models.some((m) => m.id === downloadId && m.downloaded) ?? false,
    [status],
  );

  const cancelDownload = useCallback(async () => {
    await ipc.mediaAi.cancelDownload(undefined);
    setIsDownloading(false);
    setSetupAction(null);
    appendLog("Download cancelled.", "info");
    toast.info("Download cancelled");
  }, [appendLog]);

  const waitForBackendHealthy = useCallback(
    async (timeoutMs = 60_000): Promise<MediaAiStatus | null> => {
      const deadline = Date.now() + timeoutMs;
      let latestStatus: MediaAiStatus | null = null;

      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        const nextStatus = await ipc.mediaAi
          .getStatus(undefined)
          .catch(() => null);
        if (!nextStatus) continue;
        latestStatus = nextStatus;
        setStatus(nextStatus);
        if (nextStatus.healthy) return nextStatus;
        if (!nextStatus.running && nextStatus.lastLog) break;
      }

      return latestStatus;
    },
    [],
  );

  const downloadTier = useCallback(
    async (tier: ImageTierUiConfig) => {
      setSetupAction(`download-${tier.tierId}`);
      setIsDownloading(true);
      appendLog(`Downloading ${tier.shortName} (~${tier.downloadGb} GB)…`);
      try {
        await ipc.mediaAi.downloadModels({
          models: [tier.downloadId as MediaAiModelId],
        });
        appendLog(`${tier.shortName} downloaded.`, "success");
        toast.success(`${tier.shortName} downloaded`);
        await refreshAll();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("SIGTERM") || msg.includes("cancelled")) {
          appendLog("Download cancelled.", "info");
        } else {
          appendLog(`Download failed: ${msg}`, "error");
          toast.error(msg);
        }
      } finally {
        setIsDownloading(false);
        setSetupAction(null);
      }
    },
    [appendLog, refreshAll],
  );

  // One-button setup: install deps with the detected GPU backend (if missing),
  // download every Media AI model group needed for image / audio / video /
  // transcription (skipping ones already on disk), then start the backend.
  // Each step is idempotent so re-running is safe and resumable.
  const runSetupChain = useCallback(async () => {
    // Order matters for UX: smallest fast-to-use models first so the user can
    // start generating while the larger video model is still downloading.
    const ALL_COMPONENTS: {
      id: MediaAiModelId;
      label: string;
      sizeGb: number;
    }[] = [
      { id: "whisper", label: "Whisper Base (transcription)", sizeGb: 0.15 },
      { id: "audio", label: "SpeechT5 + MMS-TTS (audio)", sizeGb: 1.0 },
      { id: "image-sd-turbo", label: "SD Turbo (image)", sizeGb: 2.5 },
      {
        id: "image-z-image-turbo",
        label: "Z-Image Turbo (image)",
        sizeGb: 6.0,
      },
      { id: "image", label: "Stable Diffusion 1.5 ONNX (image)", sizeGb: 4.0 },
      { id: "text", label: "Phi-3 mini (text)", sizeGb: 2.4 },
      { id: "video", label: "ModelScope text-to-video", sizeGb: 11.0 },
    ];

    try {
      if (!status?.venvExists) {
        setSetupChainStep("install");
        // Re-detect hardware right before installing so we pick up the GPU
        // even if the initial detect-at-startup race missed it (or the user
        // installed drivers since launching the app).
        appendLog("Detecting hardware…");
        const freshHw = await ipc.hardware
          .refreshProfile(undefined)
          .catch(() => null);
        const backend =
          freshHw?.bestMediaBackend ?? hardware?.bestMediaBackend ?? "cpu";
        if (freshHw) setHardware(freshHw);
        appendLog(
          `Installing Python dependencies (${backend} backend${freshHw?.primaryGpu?.model ? ` · ${freshHw.primaryGpu.model}` : ""})…`,
        );
        const installResult = await ipc.mediaAi.installDependenciesForBackend({
          backend: backend === "cpu" ? undefined : backend,
        });
        assertMediaAiOperationSucceeded(
          installResult,
          "Media AI dependency install failed.",
        );
        appendLog("Dependencies installed.", "success");
      }

      setSetupChainStep("download");
      // Fetch a fresh status snapshot so we don't redownload anything
      // that was completed in a previous run of this chain.
      const freshStatus = await ipc.mediaAi.getStatus(undefined);
      const isDownloaded = (id: MediaAiModelId) =>
        freshStatus?.models.some((m) => m.id === id && m.downloaded) ?? false;

      const pending = ALL_COMPONENTS.filter((c) => !isDownloaded(c.id));
      if (pending.length === 0) {
        appendLog("All Media AI models already downloaded.", "success");
      } else {
        const totalGb = pending.reduce((acc, c) => acc + c.sizeGb, 0);
        appendLog(
          `Downloading ${pending.length} model${pending.length === 1 ? "" : "s"} (~${totalGb.toFixed(2)} GB total)…`,
        );
        setIsDownloading(true);
        try {
          for (const comp of pending) {
            setSetupChainModelId(comp.id);
            appendLog(`→ ${comp.label} (~${comp.sizeGb} GB)…`);
            try {
              await ipc.mediaAi.downloadModels({ models: [comp.id] });
              appendLog(`✓ ${comp.label}`, "success");
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              // Treat user-cancelled downloads as a hard stop. Anything else
              // is logged but doesn't abort the whole chain — the user can
              // still use whatever already downloaded.
              if (msg.includes("SIGTERM") || msg.includes("cancelled")) {
                throw err;
              }
              appendLog(`✗ ${comp.label} failed: ${msg}`, "error");
            }
          }
        } finally {
          setSetupChainModelId(null);
          setIsDownloading(false);
        }
      }

      if (!isBackendOnline) {
        setSetupChainStep("start");
        appendLog("Starting backend…");
        const startStatus = await ipc.mediaAi.startBackend(undefined);
        setStatus(startStatus);
        const healthyStatus = startStatus.healthy
          ? startStatus
          : await waitForBackendHealthy();
        if (!healthyStatus?.healthy) {
          const logTail = healthyStatus?.lastLog?.trim().slice(-1200);
          throw new Error(
            `Backend did not come online.${logTail ? ` Last log: ${logTail}` : " Check the activity log."}`,
          );
        }
        appendLog("Backend online.", "success");
      }
      toast.success("Media AI ready");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      appendLog(`Setup failed: ${msg}`, "error");
      toast.error(msg);
      throw error;
    } finally {
      setSetupChainStep(null);
      setSetupChainModelId(null);
      await refreshAll();
    }
  }, [
    status,
    hardware,
    isBackendOnline,
    appendLog,
    refreshAll,
    waitForBackendHealthy,
  ]);

  const triggerOneClickSetup = useCallback(async () => {
    setSetupPhase("setting-up");
    setSetupError(null);
    try {
      await runSetupChain();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSetupError(msg);
      setSetupPhase("error");
    }
  }, [runSetupChain]);

  const installDependencies = () =>
    runSetupAction("install", async () => {
      const backend = hardware?.bestMediaBackend ?? undefined;
      const installResult = await ipc.mediaAi.installDependenciesForBackend({
        backend,
      });
      assertMediaAiOperationSucceeded(
        installResult,
        "Media AI dependency install failed.",
      );
      toast.success("Media AI dependencies installed");
    });

  const handleStartBackend = useCallback(async () => {
    setSetupPhase("starting");
    setSetupError(null);
    try {
      const startStatus = await ipc.mediaAi.startBackend(undefined);
      setStatus(startStatus);
      const healthyStatus = startStatus.healthy
        ? startStatus
        : await waitForBackendHealthy();
      if (!healthyStatus?.healthy) {
        const logTail = healthyStatus?.lastLog?.trim().slice(-1200);
        throw new Error(
          `Backend did not start in time.${logTail ? ` Last log: ${logTail}` : " Check the activity log."}`,
        );
      }
      const [tiers, hw, orch] = await Promise.all([
        ipc.orchestrator.getAvailableTiers(undefined).catch(() => null),
        ipc.hardware.getProfile(undefined).catch(() => null),
        ipc.orchestrator.getStatus(undefined).catch(() => null),
      ]);
      if (tiers) setAvailTiers(tiers);
      if (hw) setHardware(hw);
      if (orch) setOrchStatus(orch);
      setSetupPhase("online");
      toast.success("Media AI backend started");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSetupError(msg);
      setSetupPhase("error");
      toast.error(msg);
      return;
    }
  }, [waitForBackendHealthy]);

  const handleStopBackend = useCallback(async () => {
    setSetupPhase("stopping");
    try {
      await ipc.mediaAi.stopBackend(undefined);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    // Immediately reflect stopped state — IPC already waited for health check.
    setSetupPhase("stopped");
    toast.success("Media AI backend stopped");
    void refreshAll();
  }, [refreshAll]);

  // Wipes the Python venv + model markers and re-runs the full setup chain.
  // Use this when a previous install picked the wrong backend (e.g. CPU torch
  // got installed on an NVIDIA machine because nvidia-smi wasn't in PATH).
  // The downloaded HF model weights are preserved.
  const resetAndReinstall = useCallback(async () => {
    const ok = window.confirm(
      "Reset Media AI setup?\n\n" +
        "This deletes the Python environment so it can be reinstalled with the correct GPU backend. " +
        "Downloaded models will be kept.\n\n" +
        "Setup will start again immediately.",
    );
    if (!ok) return;
    setSetupPhase("setting-up");
    setSetupError(null);
    try {
      appendLog("Stopping backend and clearing Python environment…");
      await ipc.mediaAi.resetSetup({ alsoDeleteModels: false });
      appendLog("Python environment removed.", "success");
      await refreshAll();
      await runSetupChain();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSetupError(msg);
      setSetupPhase("error");
    }
  }, [appendLog, refreshAll, runSetupChain]);

  const reinstallForGpu = useCallback(async () => {
    setSetupPhase("setting-up");
    setSetupError(null);
    try {
      appendLog("Stopping backend…");
      await ipc.mediaAi.stopBackend(undefined);
      appendLog("Installing GPU dependencies…");
      const backend = hardware?.bestMediaBackend ?? undefined;
      const installResult = await ipc.mediaAi.installDependenciesForBackend({
        backend,
      });
      assertMediaAiOperationSucceeded(
        installResult,
        "GPU dependency install failed.",
      );
      appendLog("Restarting backend…");
      const startStatus = await ipc.mediaAi.startBackend(undefined);
      setStatus(startStatus);
      const healthyStatus = startStatus.healthy
        ? startStatus
        : await waitForBackendHealthy();
      if (!healthyStatus?.healthy) {
        const logTail = healthyStatus?.lastLog?.trim().slice(-1200);
        throw new Error(
          `Backend did not restart in time.${logTail ? ` Last log: ${logTail}` : " Check the activity log."}`,
        );
      }
      toast.success("GPU dependencies installed — backend restarted");
      void refreshAll();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSetupError(msg);
      setSetupPhase("error");
    }
  }, [hardware, appendLog, refreshAll, waitForBackendHealthy]);

  const handleStop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsGenerating(false);
  };

  const fetchMusicTiers = useCallback(
    async (allowBackendProbe = false): Promise<MusicTierInfo[] | null> => {
      if (!isBackendOnline && !allowBackendProbe) return null;
      setMusicTiersLoading(true);
      try {
        const res = await fetch(`${serverUrl}/v1/generate/music/tiers`);
        if (res.ok) {
          const data = (await res.json()) as {
            tiers: MusicTierInfo[];
            selected_tier_id: string;
          };
          setMusicTiers(data.tiers);
          setSelectedMusicTierId((prev) => {
            if (prev && data.tiers.some((tier) => tier.id === prev))
              return prev;
            return data.selected_tier_id;
          });
          return data.tiers;
        }
      } catch {
        // Backend may not be running yet — silent fail
      } finally {
        setMusicTiersLoading(false);
      }
      return null;
    },
    [isBackendOnline, serverUrl],
  );

  useEffect(() => {
    if (activeTab !== "music" || !isBackendOnline) return;
    void fetchMusicTiers(true);
  }, [activeTab, fetchMusicTiers, isBackendOnline]);

  const runMusicSetup = useCallback(async () => {
    appendLog("Setting up Music AI runtime...");
    const freshHw = await ipc.hardware
      .refreshProfile(undefined)
      .catch(() => null);
    const backend =
      freshHw?.bestMediaBackend ?? hardware?.bestMediaBackend ?? "cpu";
    if (freshHw) setHardware(freshHw);
    appendLog(`Installing Music AI dependencies (${backend})...`);
    const installResult = await ipc.mediaAi.installDependenciesForBackend({
      backend: backend === "cpu" ? undefined : backend,
    });
    assertMediaAiOperationSucceeded(
      installResult,
      "Music AI dependency install failed.",
    );
    appendLog("Music AI dependencies installed.", "success");

    const currentStatus = await ipc.mediaAi
      .getStatus(undefined)
      .catch(() => null);
    if (currentStatus) setStatus(currentStatus);
    if (!currentStatus?.healthy) {
      appendLog("Starting Media AI backend for music...");
      const startStatus = await ipc.mediaAi.startBackend(undefined);
      setStatus(startStatus);
      const healthyStatus = startStatus.healthy
        ? startStatus
        : await waitForBackendHealthy(90_000);
      if (!healthyStatus?.healthy) {
        const logTail = healthyStatus?.lastLog?.trim().slice(-1200);
        throw new Error(
          `Music backend did not come online.${logTail ? ` Last log: ${logTail}` : " Check the activity log."}`,
        );
      }
    }

    await refreshAll();
    const tiers = await fetchMusicTiers(true);
    if (!tiers?.length) {
      throw new Error(
        "Music backend is online, but it did not return any music model tiers.",
      );
    }
    setSetupPhase("online");
    appendLog("Music AI runtime is ready.", "success");
    toast.success("Music AI ready");
  }, [appendLog, fetchMusicTiers, hardware, refreshAll, waitForBackendHealthy]);

  // Fast path: venv already installed — just start the backend and fetch tiers.
  const startMusicBackendOnly = useCallback(async () => {
    const currentStatus = await ipc.mediaAi
      .getStatus(undefined)
      .catch(() => null);
    if (currentStatus?.healthy) {
      setSetupPhase("online");
      await fetchMusicTiers(true);
      return;
    }
    appendLog("Starting Music AI backend...");
    const startStatus = await ipc.mediaAi.startBackend(undefined);
    setStatus(startStatus);
    const healthyStatus = startStatus.healthy
      ? startStatus
      : await waitForBackendHealthy(90_000);
    if (!healthyStatus?.healthy) {
      const logTail = healthyStatus?.lastLog?.trim().slice(-1200);
      throw new Error(
        `Music backend did not come online.${logTail ? ` Last log: ${logTail}` : " Check the activity log."}`,
      );
    }
    await refreshAll();
    const tiers = await fetchMusicTiers(true);
    if (!tiers?.length) {
      throw new Error(
        "Music backend is online but did not return any music model tiers.",
      );
    }
    setSetupPhase("online");
    appendLog("Music AI backend started.", "success");
    toast.success("Music AI ready");
  }, [appendLog, fetchMusicTiers, refreshAll, waitForBackendHealthy]);

  const handleSetupMusicAi = async () => {
    if (musicSetupRunning) return;
    setMusicSetupRunning(true);
    setSetupError(null);
    // If the runtime is already installed, skip dependency reinstall — just start.
    const venvReady = status?.venvExists ?? false;
    setSetupPhase(venvReady ? "starting" : "setting-up");
    try {
      if (venvReady) {
        await startMusicBackendOnly();
      } else {
        await runMusicSetup();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setSetupError(msg);
      setSetupPhase("error");
      appendLog(`Music AI setup failed: ${msg}`, "error");
      toast.error(msg);
    } finally {
      setMusicSetupRunning(false);
    }
  };

  const handleResetMusicAi = async () => {
    if (musicSetupRunning) return;
    const ok = window.confirm(
      "Reset Music AI setup?\n\n" +
        "This deletes the Media AI Python environment so it can be recreated with a compatible Python version. Downloaded models are kept.\n\n" +
        "Music AI setup will start again immediately.",
    );
    if (!ok) return;

    setMusicSetupRunning(true);
    setSetupError(null);
    setSetupPhase("setting-up");
    try {
      appendLog("Resetting Music AI Python environment...");
      await ipc.mediaAi.resetSetup({ alsoDeleteModels: false });
      appendLog("Music AI Python environment reset.", "success");
      await refreshAll();
      await runMusicSetup();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setSetupError(msg);
      setSetupPhase("error");
      appendLog(`Music AI reset failed: ${msg}`, "error");
      toast.error(msg);
    } finally {
      setMusicSetupRunning(false);
    }
  };

  const handleDownloadMusicModel = async (tierId: string) => {
    const tier = musicModelTiers.find((x) => x.id === tierId);
    const tierLabel = tier?.label || tierId;
    setSelectedMusicTierId(tierId);
    if (!isBackendOnline) {
      appendLog(`Start the Music AI backend before downloading ${tierLabel}.`);
      toast.info("Start Music AI first, then download the selected model.");
      return;
    }
    if (musicDownloadPollRef.current !== null) {
      window.clearInterval(musicDownloadPollRef.current);
      musicDownloadPollRef.current = null;
    }
    setMusicDownloadTierId(tierId);
    appendLog(`Starting download of music model: ${tierLabel}...`);
    try {
      const response = await fetch(`${serverUrl}/v1/generate/music/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier_id: tierId }),
      });
      if (!response.ok) {
        const err = await response
          .json()
          .catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(
          (err as { detail?: string }).detail ?? `HTTP ${response.status}`,
        );
      }
      // Poll status every 3s until downloaded
      let lastProgress = -1;
      const poll = window.setInterval(() => {
        void fetchMusicTiers().then((tiers) => {
          if (!tiers) return;
          const t = tiers.find((x) => x.id === tierId);
          if (t) {
            if (t.status === "downloaded") {
              appendLog(
                `Music model ${tierLabel} downloaded successfully!`,
                "success",
              );
              setMusicDownloadTierId(null);
              window.clearInterval(poll);
              if (musicDownloadPollRef.current === poll) {
                musicDownloadPollRef.current = null;
              }
            } else if (t.status === "downloading") {
              if (t.download_progress != null) {
                const progress = t.download_progress;
                if (progress !== lastProgress) {
                  lastProgress = progress;
                  appendLog(
                    `Music model ${tierLabel} download progress: ${progress}%`,
                  );
                }
              } else if (lastProgress === -1) {
                lastProgress = 0;
                appendLog(
                  `Music model ${tierLabel}: Resolving repository details and checking local cache...`,
                );
              }
            } else if (t.status === "not_downloaded") {
              appendLog(
                `Music model ${tierLabel} download was reset or failed.`,
                "error",
              );
              setMusicDownloadTierId(null);
              window.clearInterval(poll);
              if (musicDownloadPollRef.current === poll) {
                musicDownloadPollRef.current = null;
              }
            }
          }
        });
      }, 3000);
      musicDownloadPollRef.current = poll;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMusicDownloadTierId(null);
      appendLog(`Music model download failed: ${msg}`, "error");
      toast.error(`Download failed: ${msg}`);
    }
  };

  const handleStopMusicGen = () => {
    musicGenAbortRef.current?.abort();
    musicGenAbortRef.current = null;
    setMusicGenStatus("idle");
  };

  const handleGenerateMusic = async () => {
    if (!musicGenPrompt.trim() || !isBackendOnline) return;
    if (selectedMusicTier?.status !== "downloaded") {
      toast.error("Download the selected music model first.");
      return;
    }
    const ctrl = new AbortController();
    musicGenAbortRef.current = ctrl;
    setMusicGenStatus("generating");
    setMusicGenError("");
    setMusicGenAudioUrl(null);
    setMusicGeneratedTier(null);
    appendLog(
      `Generating music: "${musicGenPrompt.slice(0, 60)}${musicGenPrompt.length > 60 ? "..." : ""}" (${musicGenDuration}s)…`,
    );
    try {
      const response = await fetch(`${serverUrl}/v1/generate/music`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: musicGenPrompt.trim(),
          duration_seconds: musicGenDuration,
          tier: selectedMusicTier?.id,
        }),
      });
      if (!response.ok) {
        const err = await response
          .json()
          .catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(
          (err as { detail?: string }).detail ?? `HTTP ${response.status}`,
        );
      }
      const data = (await response.json()) as {
        audio_url: string;
        tier: string;
      };
      setMusicGenAudioUrl(`${serverUrl}${data.audio_url}`);
      setMusicGeneratedTier(data.tier);
      setMusicGenStatus("done");
      appendLog("Music generation complete.", "success");
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setMusicGenStatus("idle");
        appendLog("Music generation stopped.", "info");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setMusicGenError(msg);
        setMusicGenStatus("error");
        appendLog(`Music generation failed: ${msg}`, "error");
      }
    } finally {
      musicGenAbortRef.current = null;
    }
  };

  const handleMusicSearch = async () => {
    if (!musicQuery.trim()) return;
    setMusicSearching(true);
    setMusicSearchError("");
    setMusicResults([]);
    audioRef.current?.pause();
    setPlayingTrackId(null);
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(musicQuery.trim())}&media=music&entity=song&limit=24`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Search failed: ${res.status}`);
      const data = (await res.json()) as { results: ItunesTrack[] };
      const withPreview = data.results.filter((t) => !!t.previewUrl);
      setMusicResults(withPreview);
      if (withPreview.length === 0) setMusicSearchError("No results found.");
    } catch (err) {
      setMusicSearchError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setMusicSearching(false);
    }
  };

  const handleTogglePreview = (track: ItunesTrack) => {
    if (playingTrackId === track.trackId) {
      audioRef.current?.pause();
      setPlayingTrackId(null);
    } else {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.onended = null;
      }
      const audio = new Audio(track.previewUrl);
      audio.onended = () => setPlayingTrackId(null);
      audioRef.current = audio;
      audio.play().catch(() => setPlayingTrackId(null));
      setPlayingTrackId(track.trackId);
    }
  };

  const handleDownloadTrack = async (track: ItunesTrack) => {
    await ipc.system.openExternalUrl(track.previewUrl);
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      toast.error("Please enter a prompt");
      return;
    }

    setIsGenerating(true);
    setResult(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    if (activeTab === "image") {
      if (isBackendOnline) {
        const tier = selectedImageTier;
        const settings = imageSettings;
        // Auto-download the selected model if its marker is missing. From the
        // user's POV this stays a single click: pressing Generate triggers the
        // download then immediately generates.
        if (!tierDownloaded(tier.downloadId)) {
          appendLog(
            `${tier.shortName} not on disk — downloading before generation…`,
          );
          toast.info(
            `Downloading ${tier.shortName} first — this can take a few minutes.`,
          );
          try {
            await ipc.mediaAi.downloadModels({
              models: [tier.downloadId as MediaAiModelId],
            });
            appendLog(`${tier.shortName} downloaded.`, "success");
            await refreshAll();
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            appendLog(`Download failed: ${msg}`, "error");
            toast.error(`Download failed: ${msg}`);
            setIsGenerating(false);
            return;
          }
        }
        appendLog(
          `Generating ${settings.width}×${settings.height} via ${tier.shortName} · ${settings.steps} step(s)…`,
        );
        toast.info(
          `Generating locally with ${tier.shortName} (${settings.steps} step${settings.steps === 1 ? "" : "s"}).`,
        );
        try {
          const response = await fetch(`${serverUrl}/v1/generate/image`, {
            method: "POST",
            signal: ctrl.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: prompt.trim(),
              tier: tier.tierId,
              steps: settings.steps,
              guidance: tier.supportsGuidance ? settings.guidance : 0.0,
              width: settings.width,
              height: settings.height,
              ...(settings.seed !== null ? { seed: settings.seed } : {}),
            }),
          });
          if (!response.ok) {
            const errorData = await response
              .json()
              .catch(() => ({ detail: `HTTP ${response.status}` }));
            throw new Error(
              (errorData as { detail?: string }).detail ??
                `HTTP ${response.status}`,
            );
          }
          const data = (await response.json()) as {
            image_url?: string;
            tier?: string;
            warning?: string;
          };
          const imageUrl = data.image_url;
          if (!imageUrl) {
            throw new Error("Backend returned no image_url in response");
          }
          // Fetch image bytes and convert to blob URL — avoids Electron
          // img-src CSP restrictions on http://127.0.0.1 direct loading.
          const imgResp = await fetch(`${serverUrl}${imageUrl}`);
          if (!imgResp.ok)
            throw new Error(`Failed to fetch image: HTTP ${imgResp.status}`);
          const blob = await imgResp.blob();
          const blobUrl = URL.createObjectURL(blob);
          setResult({
            tab: "image",
            absoluteUrl: blobUrl,
            filename: `image-${Date.now()}.png`,
            source: "local",
          });
          appendLog(
            `Image generated${data.tier ? ` (${data.tier})` : ""}.`,
            "success",
          );
          toast.success(
            `Image generated locally${data.tier ? ` (${data.tier})` : ""}`,
          );
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            appendLog("Image generation stopped.", "info");
          } else {
            const msg = error instanceof Error ? error.message : String(error);
            appendLog(`Generation failed: ${msg}`, "error");
            toast.error(msg);
          }
        } finally {
          setIsGenerating(false);
          abortRef.current = null;
        }
      } else {
        // Cloud fallback when local backend is offline
        const url = pollinationsUrl(prompt.trim(), { width: 768, height: 768 });
        setResult({
          tab: "image",
          absoluteUrl: url,
          filename: `image-${Date.now()}.jpg`,
          source: "cloud",
        });
        toast.info(
          "Backend offline — using cloud fallback. Start the backend to generate locally.",
        );
        setIsGenerating(false);
      }
      return;
    }

    if (activeTab === "video") {
      if (isBackendOnline) {
        toast.info(
          "Generating video locally… first run downloads the model (~11GB) and may take 10–15 minutes.",
        );
        try {
          const response = await fetch(`${serverUrl}/v1/generate/video`, {
            method: "POST",
            signal: ctrl.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: prompt.trim() }),
          });
          if (!response.ok) {
            const errorData = await response
              .json()
              .catch(() => ({ detail: `HTTP ${response.status}` }));
            throw new Error(
              (errorData as { detail?: string }).detail ??
                `HTTP ${response.status}`,
            );
          }
          const data = (await response.json()) as { video_url?: string };
          setResult({
            tab: "video",
            url: data.video_url,
            filename: `video-${Date.now()}.mp4`,
            source: "local",
          });
          toast.success("Video generated locally");
        } catch (error) {
          if (!(error instanceof Error && error.name === "AbortError")) {
            toast.error(error instanceof Error ? error.message : String(error));
          }
        } finally {
          setIsGenerating(false);
          abortRef.current = null;
        }
      } else {
        // Cloud fallback when local backend is offline
        const baseSeed = Math.floor(Math.random() * 1_000_000);
        const frames = Array.from({ length: 6 }, (_, i) =>
          pollinationsUrl(prompt.trim(), {
            width: 640,
            height: 360,
            seed: baseSeed + i,
          }),
        );
        setResult({
          tab: "video",
          frames,
          filename: `video-${Date.now()}.gif`,
          source: "cloud",
        });
        toast.info(
          "Backend offline — using cloud fallback. Start the backend to generate locally.",
        );
        setIsGenerating(false);
      }
      return;
    }

    if (!isBackendOnline) {
      toast.error("Start the Media AI backend before generating.");
      setIsGenerating(false);
      return;
    }

    try {
      let endpoint = "";
      let body: Record<string, unknown> = { prompt: prompt.trim() };

      // image + video now go through the Pollinations cloud path above; only
      // audio (text-to-speech) and audio-transcription still hit the local
      // backend here.
      if (activeTab === "audio") {
        endpoint = "/v1/generate/audio/tts";
        body = { text: prompt.trim() };
      } else {
        return;
      }

      const response = await fetch(`${serverUrl}${endpoint}`, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(
          (errorData as { detail?: string }).detail ??
            `HTTP ${response.status}`,
        );
      }

      const data = (await response.json()) as Record<string, unknown>;
      setResult({
        tab: activeTab,
        content: typeof data.text === "string" ? data.text : undefined,
        url:
          typeof data.image_url === "string"
            ? data.image_url
            : typeof data.audio_url === "string"
              ? data.audio_url
              : typeof data.video_url === "string"
                ? data.video_url
                : undefined,
        filename: typeof data.filename === "string" ? data.filename : undefined,
        source: "local",
      });

      toast.success(`${activeTab} generated successfully`);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        console.error("Generation error:", error);
        toast.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setIsGenerating(false);
      abortRef.current = null;
    }
  };

  const handleTranscribe = async () => {
    if (!transcribeFile) {
      toast.error("Please select an audio file");
      return;
    }
    if (!isBackendOnline) {
      toast.error("Start the Media AI backend first.");
      return;
    }

    setIsGenerating(true);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("audio", transcribeFile);

      const response = await fetch(`${serverUrl}/v1/transcribe`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(
          (errorData as { detail?: string }).detail ??
            `HTTP ${response.status}`,
        );
      }

      const data = (await response.json()) as { text?: string };
      setResult({
        tab: "transcribe",
        content: data.text ?? "(empty transcript)",
      });

      toast.success("Transcription complete");
    } catch (error) {
      console.error("Transcription error:", error);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = () => {
    if (!result) return;
    let href: string | undefined;
    if (result.absoluteUrl) {
      href = result.absoluteUrl;
    } else if (result.url) {
      href = `${serverUrl}${result.url}`;
    } else if (result.frames && result.frames.length > 0) {
      href = result.frames[0];
    }
    if (!href) return;
    const link = document.createElement("a");
    link.href = href;
    link.download = result.filename ?? `generated-${activeTab}`;
    link.target = "_blank";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const bestTier = (
    key: "image" | "audio" | "audioStt" | "video",
  ): MediaTier | null => {
    const list = availTiers?.[key];
    return list && list.length > 0 ? list[0] : null;
  };

  const renderResult = () => {
    if (!result) return null;

    const imageSrc = result.absoluteUrl
      ? result.absoluteUrl
      : result.url
        ? `${serverUrl}${result.url}`
        : undefined;
    const hasDownloadable =
      result.absoluteUrl || result.url || (result.frames?.length ?? 0) > 0;

    return (
      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              {result.tab === "transcribe"
                ? "Transcription"
                : `Generated ${result.tab}`}
              {result.source === "cloud" && (
                <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-medium uppercase text-sky-500">
                  Cloud
                </span>
              )}
              {result.source === "local" && (
                <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-500">
                  Local
                </span>
              )}
            </CardTitle>
            <CardDescription>
              {result.tab === "transcribe"
                ? "Speech-to-text output"
                : "Your AI-generated content is ready"}
            </CardDescription>
          </div>
          {hasDownloadable && (
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download className="mr-2 h-4 w-4" />
              Download
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {result.content && (
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="whitespace-pre-wrap text-sm leading-6">
                {result.content}
              </p>
            </div>
          )}
          {result.tab === "image" && result.source === "local" && imageSrc && (
            <LocalImage src={imageSrc} />
          )}
          {result.tab === "image" && result.source === "cloud" && imageSrc && (
            <LoadingImage
              src={imageSrc}
              alt="Generated"
              className="max-h-[512px] max-w-full rounded-lg border shadow-sm"
            />
          )}
          {result.tab === "audio" && result.url && (
            <audio controls className="w-full">
              <source src={`${serverUrl}${result.url}`} type="audio/wav" />
            </audio>
          )}
          {result.tab === "video" &&
            result.frames &&
            result.frames.length > 0 && (
              <VideoSlideshow frames={result.frames} />
            )}
          {result.tab === "video" && result.url && !result.frames && (
            <video controls className="max-h-[420px] w-full rounded-lg border">
              <source src={`${serverUrl}${result.url}`} type="video/mp4" />
            </video>
          )}
        </CardContent>
      </Card>
    );
  };

  const musicSetupTitle = status?.venvExists
    ? "Start Music AI"
    : "Auto Setup Music AI";
  const musicSetupDescription = status?.venvExists
    ? "Runtime already installed — click to start the backend and see your downloaded models."
    : "Install the ACE-Step runtime, start the backend, then choose a music model.";
  const hasLiveMusicModelStatus = musicTiers.length > 0;

  return (
    <div className="h-full w-full overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-6">
          <h1 className="flex items-center text-3xl font-bold">
            <Sparkles className="mr-3 h-8 w-8 text-primary" />
            Media AI
          </h1>
          <p className="mt-2 text-muted-foreground">
            Local image, audio, transcription, and video generation — hardware
            accelerated.
          </p>
        </div>

        <SetupBanner
          phase={setupPhase}
          setupChainStep={setupChainStep}
          setupChainModelId={setupChainModelId}
          setupError={setupError}
          status={status}
          hardware={hardware}
          backendHardware={backendHardware}
          orchStatus={orchStatus}
          availTiers={availTiers}
          isDownloading={isDownloading}
          setupAction={setupAction}
          showLog={showLog}
          eventLog={eventLog}
          serverUrl={serverUrl}
          onOneClickSetup={() => void triggerOneClickSetup()}
          onStartBackend={() => void handleStartBackend()}
          onStopBackend={() => void handleStopBackend()}
          onRefresh={() => void refreshAll()}
          onInstall={() => void installDependencies()}
          onToggleLog={() => setShowLog((v) => !v)}
          onCancelDownload={() => void cancelDownload()}
          onReinstallForGpu={() => void reinstallForGpu()}
          onResetAndReinstall={() => void resetAndReinstall()}
          onRetry={() => {
            setSetupPhase("checking");
            setSetupError(null);
            void refreshAll();
          }}
        />

        {/* Generation Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => {
            setActiveTab(v as MediaTab);
            setResult(null);
            setPrompt("");
            if (v !== "music") {
              audioRef.current?.pause();
              setPlayingTrackId(null);
            } else {
              // Fetch tier status each time user opens Music tab
              void fetchMusicTiers();
            }
          }}
        >
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="image" className="flex items-center gap-2">
              <Image className="h-4 w-4" />
              <span className="hidden sm:inline">Image</span>
            </TabsTrigger>
            <TabsTrigger value="audio" className="flex items-center gap-2">
              <Music className="h-4 w-4" />
              <span className="hidden sm:inline">Audio</span>
            </TabsTrigger>
            <TabsTrigger value="transcribe" className="flex items-center gap-2">
              <Mic className="h-4 w-4" />
              <span className="hidden sm:inline">Transcribe</span>
            </TabsTrigger>
            <TabsTrigger value="video" className="flex items-center gap-2">
              <Video className="h-4 w-4" />
              <span className="hidden sm:inline">Video</span>
            </TabsTrigger>
            <TabsTrigger value="music" className="flex items-center gap-2">
              <Search className="h-4 w-4" />
              <span className="hidden sm:inline">Music</span>
            </TabsTrigger>
          </TabsList>

          {/* Image */}
          <TabsContent value="image" className="mt-6 space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle>Image Generation</CardTitle>
                    <CardDescription>
                      Pick a model that fits your hardware. Settings persist per
                      model across sessions.
                    </CardDescription>
                  </div>
                  <TierBadge tier={bestTier("image")} />
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <ImageModelPicker
                  selectedTierId={selectedImageTier.tierId}
                  onSelect={(id) => setSelectedImageTierId(id)}
                  tiers={USER_FACING_IMAGE_TIERS}
                  isTierDownloaded={(id) => tierDownloaded(id)}
                  onDownload={(tier) => void downloadTier(tier)}
                  onCancelDownload={() => void cancelDownload()}
                  onDeleteAndRedownload={(tier) => {
                    void (async () => {
                      try {
                        await ipc.mediaAi.deleteModel({
                          modelId:
                            tier.downloadId as import("@/ipc/types").MediaAiModelId,
                        });
                        await refreshAll();
                        toast.info(
                          `${tier.shortName} deleted — ready to re-download.`,
                        );
                        void downloadTier(tier);
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : String(e));
                      }
                    })();
                  }}
                  isDownloading={isDownloading}
                  downloadingTierId={
                    setupAction?.startsWith("download-")
                      ? setupAction.slice("download-".length)
                      : null
                  }
                />

                <button
                  type="button"
                  onClick={() => setShowImageSettings((v) => !v)}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      !showImageSettings && "-rotate-90",
                    )}
                  />
                  <Settings2 className="h-3.5 w-3.5" />
                  Settings ({imageSettings.width}×{imageSettings.height},{" "}
                  {imageSettings.steps} step
                  {imageSettings.steps === 1 ? "" : "s"})
                </button>
                {showImageSettings && (
                  <ImageSettingsPanel
                    tier={selectedImageTier}
                    settings={imageSettings}
                    onChange={(patch) =>
                      persistImageSettings(selectedImageTier.tierId, patch)
                    }
                    onReset={() =>
                      persistImageSettings(
                        selectedImageTier.tierId,
                        defaultSettingsFor(selectedImageTier),
                      )
                    }
                  />
                )}

                <GenerationForm
                  promptId="image-prompt"
                  prompt={prompt}
                  setPrompt={setPrompt}
                  placeholder="A futuristic city at sunset with neon reflections..."
                  buttonText={`Generate with ${selectedImageTier.shortName}`}
                  buttonIcon={<Image className="mr-2 h-4 w-4" />}
                  disabled={!prompt.trim()}
                  loading={isGenerating && activeTab === "image"}
                  onGenerate={() => void handleGenerate()}
                  onStop={handleStop}
                />
              </CardContent>
            </Card>

            <EventLogPanel
              entries={eventLog}
              backendLog={status?.lastLog}
              open={showLog}
              onToggle={() => setShowLog((v) => !v)}
            />
          </TabsContent>

          {/* Audio */}
          <TabsContent value="audio" className="mt-6">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle>Text-to-Speech</CardTitle>
                    <CardDescription>
                      Generate speech with XTTS-v2 (GPU) or Piper (CPU
                      fallback).
                    </CardDescription>
                  </div>
                  <TierBadge tier={bestTier("audio")} />
                </div>
              </CardHeader>
              <CardContent>
                <GenerationForm
                  promptId="audio-prompt"
                  prompt={prompt}
                  setPrompt={setPrompt}
                  placeholder="Enter the text you want to convert to speech..."
                  buttonText="Generate Audio"
                  buttonIcon={<Music className="mr-2 h-4 w-4" />}
                  disabled={isGenerating || !prompt.trim() || !isBackendOnline}
                  loading={isGenerating && activeTab === "audio"}
                  onGenerate={() => void handleGenerate()}
                  onStop={handleStop}
                />
              </CardContent>
            </Card>
          </TabsContent>

          {/* Transcribe */}
          <TabsContent value="transcribe" className="mt-6">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle>Speech-to-Text</CardTitle>
                    <CardDescription>
                      Transcribe audio files using Whisper running locally.
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Cpu className="h-3 w-3 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">
                      Whisper
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Audio file</Label>
                    <div
                      className={cn(
                        "flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-colors",
                        transcribeFile
                          ? "border-primary/50 bg-primary/5"
                          : "border-muted-foreground/25 hover:border-muted-foreground/50",
                      )}
                      onClick={() => fileInputRef.current?.click()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          fileInputRef.current?.click();
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      {transcribeFile ? (
                        <div className="flex items-center gap-2">
                          <FileAudio className="h-5 w-5 text-primary" />
                          <span className="text-sm font-medium">
                            {transcribeFile.name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            ({Math.round(transcribeFile.size / 1024)} KB)
                          </span>
                        </div>
                      ) : (
                        <>
                          <Upload className="mb-2 h-8 w-8 text-muted-foreground" />
                          <p className="text-sm text-muted-foreground">
                            Click to upload an audio file
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            WAV, MP3, M4A, FLAC, OGG
                          </p>
                        </>
                      )}
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      onChange={(e) =>
                        setTranscribeFile(e.target.files?.[0] ?? null)
                      }
                    />
                  </div>
                  <Button
                    onClick={() => void handleTranscribe()}
                    disabled={!transcribeFile || !isBackendOnline}
                    aria-busy={isGenerating && activeTab === "transcribe"}
                    className={cn(
                      "w-full",
                      isGenerating &&
                        activeTab === "transcribe" &&
                        "pointer-events-none cursor-wait",
                    )}
                  >
                    {isGenerating && activeTab === "transcribe" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="mr-2 h-4 w-4" />
                    )}
                    {isGenerating && activeTab === "transcribe"
                      ? "Transcribing..."
                      : "Transcribe"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Video */}
          <TabsContent value="video" className="mt-6">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle>Video Generation</CardTitle>
                    <CardDescription>
                      Generate short video clips — requires significant VRAM.
                    </CardDescription>
                  </div>
                  <TierBadge tier={bestTier("video")} />
                </div>
              </CardHeader>
              <CardContent>
                <GenerationForm
                  promptId="video-prompt"
                  prompt={prompt}
                  setPrompt={setPrompt}
                  placeholder="A gentle ocean wave washing over sand at sunset..."
                  buttonText="Generate Video"
                  buttonIcon={<Video className="mr-2 h-4 w-4" />}
                  disabled={isGenerating || !prompt.trim()}
                  loading={isGenerating && activeTab === "video"}
                  onGenerate={() => void handleGenerate()}
                  onStop={handleStop}
                />
              </CardContent>
            </Card>
          </TabsContent>

          {/* Music — AI Generate + Search */}
          <TabsContent value="music" className="mt-6 space-y-4">
            {/* Sub-mode toggle */}
            <div className="flex gap-1 border-b border-border pb-0">
              {(["generate", "search"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setMusicMode(mode)}
                  className={cn(
                    "flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px capitalize",
                    musicMode === mode
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {mode === "generate" ? (
                    <Sparkles className="h-3.5 w-3.5" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                  {mode === "generate" ? "Generate AI Music" : "Search Songs"}
                </button>
              ))}
            </div>

            {/* ── AI Music Generation ── */}
            {musicMode === "generate" && (
              <div className="space-y-4">
                {!isBackendOnline && (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Wrench className="h-4 w-4" />
                        {musicSetupTitle}
                      </CardTitle>
                      <CardDescription>{musicSetupDescription}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {setupError && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                          {setupError}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          onClick={() => void handleSetupMusicAi()}
                          disabled={
                            musicSetupRunning || !status?.backendAvailable
                          }
                        >
                          {musicSetupRunning ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Wrench className="mr-2 h-4 w-4" />
                          )}
                          {musicSetupRunning
                            ? "Setting Up Music AI..."
                            : musicSetupTitle}
                        </Button>
                        {status?.venvExists && (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void handleResetMusicAi()}
                            disabled={
                              musicSetupRunning || !status?.backendAvailable
                            }
                          >
                            Reset Music Runtime
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <CardTitle className="flex items-center gap-2">
                          <HardDrive className="h-5 w-5" />
                          Music Models
                        </CardTitle>
                        <CardDescription>
                          Choose a local song model, download it once, then use
                          it for generation.
                        </CardDescription>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            "rounded border px-2 py-1 text-xs font-medium",
                            isBackendOnline
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                              : "border-amber-500/30 bg-amber-500/10 text-amber-600",
                          )}
                        >
                          {isBackendOnline
                            ? "Backend online"
                            : "Backend offline"}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void fetchMusicTiers(true)}
                          disabled={!isBackendOnline || musicTiersLoading}
                        >
                          {musicTiersLoading ? (
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="mr-2 h-3.5 w-3.5" />
                          )}
                          Refresh
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {!isBackendOnline && (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                        <span>
                          Set up and start Music AI to check downloads and fetch
                          model weights.
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleSetupMusicAi()}
                          disabled={
                            musicSetupRunning || !status?.backendAvailable
                          }
                        >
                          {musicSetupRunning ? (
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Wrench className="mr-2 h-3.5 w-3.5" />
                          )}
                          Start Music AI
                        </Button>
                      </div>
                    )}

                    <div className="grid gap-3 md:grid-cols-2">
                      {musicModelTiers.map((tier) => {
                        const isChosen = selectedMusicTier?.id === tier.id;
                        const isBusy =
                          tier.status === "downloading" ||
                          musicDownloadTierId === tier.id;
                        const statusLabel = !isBackendOnline
                          ? "Needs backend"
                          : !hasLiveMusicModelStatus && musicTiersLoading
                            ? "Checking"
                            : tier.status === "downloaded"
                              ? "Downloaded"
                              : isBusy
                                ? "Downloading"
                                : "Not downloaded";
                        const statusColor =
                          tier.status === "downloaded"
                            ? "border-emerald-500/30 bg-emerald-500/5"
                            : isBusy
                              ? "border-sky-500/30 bg-sky-500/5"
                              : "border-border bg-muted/10";
                        return (
                          <div
                            key={tier.id}
                            className={cn(
                              "rounded-lg border p-3 space-y-3 transition-colors",
                              statusColor,
                              isChosen && "ring-1 ring-primary/50",
                            )}
                          >
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <div className="flex items-center gap-2 min-w-0">
                                {tier.selected && (
                                  <span className="shrink-0 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
                                    Recommended
                                  </span>
                                )}
                                {isChosen && (
                                  <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                                    Selected
                                  </span>
                                )}
                                <span className="text-sm font-medium">
                                  {tier.label}
                                </span>
                              </div>
                              <span
                                className={cn(
                                  "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase",
                                  tier.status === "downloaded"
                                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                                    : isBusy
                                      ? "border-sky-500/30 bg-sky-500/10 text-sky-600"
                                      : "border-border bg-muted/20 text-muted-foreground",
                                )}
                              >
                                {statusLabel}
                              </span>
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              {tier.description}
                            </p>
                            <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                              <span className="rounded border border-border bg-background/50 px-1.5 py-0.5">
                                {tier.vram_mb >= 1000
                                  ? `${tier.vram_mb / 1000} GB VRAM`
                                  : `${tier.vram_mb} MB VRAM`}
                              </span>
                              <span className="rounded border border-border bg-background/50 px-1.5 py-0.5">
                                ~{(tier.download_size_mb / 1024).toFixed(2)} GB
                              </span>
                              <span className="rounded border border-border bg-background/50 px-1.5 py-0.5">
                                {tier.uses_lm ? "Planner on" : "DiT only"}
                              </span>
                              <span className="rounded border border-border bg-background/50 px-1.5 py-0.5">
                                Vocals + instruments
                              </span>
                            </div>
                            {isBusy && (
                              <div className="mt-2 space-y-1">
                                <div className="flex items-center justify-between text-[10px] text-sky-600 font-medium">
                                  <span>Download Progress</span>
                                  <span>
                                    {tier.download_progress != null
                                      ? `${tier.download_progress}%`
                                      : "Preparing"}
                                  </span>
                                </div>
                                <div className="w-full h-1.5 bg-sky-500/10 rounded-full overflow-hidden">
                                  {tier.download_progress != null ? (
                                    <div
                                      className="h-full bg-sky-500 rounded-full transition-all duration-300"
                                      style={{
                                        width: `${tier.download_progress}%`,
                                      }}
                                    />
                                  ) : (
                                    <div className="h-full w-1/3 animate-pulse rounded-full bg-sky-500" />
                                  )}
                                </div>
                              </div>
                            )}
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant={isChosen ? "default" : "outline"}
                                className="h-8 px-3 text-xs"
                                onClick={() => setSelectedMusicTierId(tier.id)}
                              >
                                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                                {isChosen ? "Selected" : "Use Model"}
                              </Button>
                              {tier.status === "downloaded" ? (
                                <span className="inline-flex h-8 items-center rounded border border-emerald-500/30 bg-emerald-500/10 px-2 text-xs font-medium text-emerald-600">
                                  Ready to generate
                                </span>
                              ) : !isBackendOnline ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 px-3 text-xs"
                                  onClick={() => void handleSetupMusicAi()}
                                  disabled={
                                    musicSetupRunning ||
                                    !status?.backendAvailable
                                  }
                                >
                                  <Wrench className="mr-1.5 h-3.5 w-3.5" />
                                  Set Up to Download
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 px-3 text-xs"
                                  onClick={() =>
                                    void handleDownloadMusicModel(tier.id)
                                  }
                                  disabled={
                                    isBusy || !tier.available_for_backend
                                  }
                                >
                                  {isBusy ? (
                                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Download className="mr-1.5 h-3.5 w-3.5" />
                                  )}
                                  {isBusy ? "Downloading" : "Download Model"}
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="flex items-center gap-2">
                          <Sparkles className="h-5 w-5" />
                          Generate Music
                        </CardTitle>
                        <CardDescription>
                          {selectedMusicTier
                            ? `Using ${selectedMusicTier.label}`
                            : "Download a music model, then describe the song."}
                        </CardDescription>
                      </div>
                      {!isBackendOnline && (
                        <span className="text-xs text-amber-600 border border-amber-500/30 bg-amber-500/10 rounded px-2 py-1">
                          Backend offline
                        </span>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Model not downloaded warning */}
                    {selectedMusicTier?.status === "not_downloaded" && (
                      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                        <Download className="h-4 w-4 mt-0.5 shrink-0" />
                        <span>
                          Download the selected model before generating (~
                          {(
                            (selectedMusicTier.download_size_mb ?? 5000) / 1024
                          ).toFixed(2)}{" "}
                          GB).
                        </span>
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor="music-prompt">Prompt / Lyrics</Label>
                      <Textarea
                        id="music-prompt"
                        placeholder="[verse]\nWalking down the road at night\nCity lights reflecting bright\n\n[chorus]\nThis is my song, my melody..."
                        value={musicGenPrompt}
                        onChange={(e) => setMusicGenPrompt(e.target.value)}
                        rows={4}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                            void handleGenerateMusic();
                        }}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Duration</Label>
                      <div className="flex flex-wrap gap-2">
                        {[10, 15, 30, 60, 120].map((sec) => (
                          <button
                            key={sec}
                            type="button"
                            onClick={() => setMusicGenDuration(sec)}
                            className={cn(
                              "rounded border px-3 py-1.5 text-sm font-medium transition-colors",
                              musicGenDuration === sec
                                ? "border-primary/60 bg-primary/15 text-foreground"
                                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                            )}
                          >
                            {sec >= 60 ? `${sec / 60}m` : `${sec}s`}
                          </button>
                        ))}
                      </div>
                    </div>

                    {musicGenStatus === "error" && (
                      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                        <Square className="h-4 w-4 mt-0.5 shrink-0" />
                        {musicGenError}
                      </div>
                    )}

                    {musicGenStatus === "done" && musicGenAudioUrl && (
                      <div className="space-y-2">
                        <p className="text-sm font-medium text-green-600 dark:text-green-400 flex items-center gap-1.5">
                          <Sparkles className="h-4 w-4" />
                          Music generated
                        </p>
                        {musicGeneratedTier && (
                          <p className="text-xs text-muted-foreground">
                            {musicTiers.find(
                              (tier) => tier.id === musicGeneratedTier,
                            )?.label ?? musicGeneratedTier}
                          </p>
                        )}
                        <audio
                          controls
                          autoPlay
                          className="w-full"
                          src={musicGenAudioUrl}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const a = document.createElement("a");
                            a.href = musicGenAudioUrl;
                            a.download = `music-${Date.now()}.wav`;
                            a.click();
                          }}
                        >
                          <Download className="mr-2 h-3.5 w-3.5" />
                          Download WAV
                        </Button>
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Button
                        onClick={() => void handleGenerateMusic()}
                        disabled={
                          !musicGenPrompt.trim() ||
                          !isBackendOnline ||
                          selectedMusicTier?.status !== "downloaded" ||
                          musicGenStatus === "generating"
                        }
                        aria-busy={musicGenStatus === "generating"}
                        className={cn(
                          "flex-1",
                          musicGenStatus === "generating" &&
                            "pointer-events-none cursor-wait",
                        )}
                      >
                        {musicGenStatus === "generating" ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="mr-2 h-4 w-4" />
                        )}
                        {musicGenStatus === "generating"
                          ? `Generating ${musicGenDuration >= 60 ? musicGenDuration / 60 + "m" : musicGenDuration + "s"} of music…`
                          : selectedMusicTier?.status !== "downloaded"
                            ? "Download Model First"
                            : "Generate Music"}
                      </Button>
                      {musicGenStatus === "generating" && (
                        <Button variant="outline" onClick={handleStopMusicGen}>
                          <Square className="mr-2 h-4 w-4" />
                          Stop
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>

                <EventLogPanel
                  entries={eventLog}
                  backendLog={status?.lastLog}
                  open={showLog}
                  onToggle={() => setShowLog((v) => !v)}
                />
              </div>
            )}

            {/* ── Search Songs ── */}
            {musicMode === "search" && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Search className="h-5 w-5" />
                    Search Songs &amp; Ringtones
                  </CardTitle>
                  <CardDescription>
                    Search the iTunes catalog. Preview 30-second clips and
                    download them to use in your apps.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={musicQuery}
                      onChange={(e) => setMusicQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleMusicSearch();
                      }}
                      placeholder="Search songs, artists, or ringtones..."
                      className="flex-1 h-9 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
                    />
                    <Button
                      onClick={() => void handleMusicSearch()}
                      disabled={!musicQuery.trim() || musicSearching}
                    >
                      {musicSearching ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Search className="mr-2 h-4 w-4" />
                      )}
                      {musicSearching ? "Searching..." : "Search"}
                    </Button>
                  </div>

                  {musicSearchError && (
                    <p className="text-sm text-muted-foreground">
                      {musicSearchError}
                    </p>
                  )}

                  {musicResults.length > 0 && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3 max-h-[520px] overflow-y-auto pr-1">
                      {musicResults.map((track) => (
                        <div
                          key={track.trackId}
                          className={cn(
                            "rounded-lg border p-2.5 space-y-2 transition-colors",
                            playingTrackId === track.trackId
                              ? "border-primary/50 bg-primary/5"
                              : "hover:bg-muted/40",
                          )}
                        >
                          <img
                            src={track.artworkUrl100.replace(
                              "100x100bb",
                              "300x300bb",
                            )}
                            alt={track.collectionName}
                            className="w-full aspect-square rounded object-cover"
                            loading="lazy"
                          />
                          <div className="min-w-0">
                            <p className="text-xs font-medium truncate leading-tight">
                              {track.trackName}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {track.artistName}
                            </p>
                          </div>
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              variant={
                                playingTrackId === track.trackId
                                  ? "default"
                                  : "outline"
                              }
                              className="flex-1 h-7 px-2"
                              onClick={() => handleTogglePreview(track)}
                              title={
                                playingTrackId === track.trackId
                                  ? "Pause"
                                  : "Play preview"
                              }
                            >
                              {playingTrackId === track.trackId ? (
                                <Pause className="h-3 w-3" />
                              ) : (
                                <Play className="h-3 w-3" />
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="flex-1 h-7 px-2"
                              onClick={() => void handleDownloadTrack(track)}
                              title="Open in browser to download"
                            >
                              <Download className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>

        {renderResult()}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/20 p-3">
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-sm">{value ?? "Unavailable"}</div>
    </div>
  );
}

function TierRow({ label, tier }: { label: string; tier: MediaTier | null }) {
  return (
    <div className="flex items-center justify-between rounded-lg border bg-muted/10 px-3 py-2">
      <span className="text-sm font-medium">{label}</span>
      <TierBadge tier={tier} />
    </div>
  );
}

// ImageModelPicker — dropdown + status badge + per-row Download button.
// Reads downloaded state from `isTierDownloaded(downloadId)` (which the
// parent computes from MediaAiStatus.models, populated by the backend's
// per-tier marker files).
function ImageModelPicker({
  selectedTierId,
  onSelect,
  tiers,
  isTierDownloaded,
  onDownload,
  onCancelDownload,
  onDeleteAndRedownload,
  isDownloading,
  downloadingTierId,
}: {
  selectedTierId: string;
  onSelect: (tierId: string) => void;
  tiers: readonly ImageTierUiConfig[];
  isTierDownloaded: (downloadId: string) => boolean;
  onDownload: (tier: ImageTierUiConfig) => void;
  onCancelDownload: () => void;
  onDeleteAndRedownload: (tier: ImageTierUiConfig) => void;
  isDownloading: boolean;
  downloadingTierId: string | null;
}) {
  const selected = tiers.find((t) => t.tierId === selectedTierId) ?? tiers[0];
  const selectedDownloaded = isTierDownloaded(selected.downloadId);
  const selectedIsDownloading = downloadingTierId === selected.tierId;

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Model
        </Label>
        {selectedDownloaded ? (
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-500">
              Downloaded
            </span>
            <button
              type="button"
              title="Delete model files and re-download"
              onClick={() => onDeleteAndRedownload(selected)}
              disabled={isDownloading}
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-40 transition-colors"
            >
              Re-download
            </button>
          </div>
        ) : selectedIsDownloading ? (
          <span className="inline-flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-sky-500">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            Downloading…
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-500">
            Not downloaded
          </span>
        )}
      </div>

      <Select
        value={selectedTierId}
        onValueChange={(v) => v && onSelect(v as string)}
      >
        <SelectTrigger className="w-full">
          <SelectValue>{selected.shortName}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {tiers.map((tier) => {
            const downloaded = isTierDownloaded(tier.downloadId);
            return (
              <SelectItem key={tier.tierId} value={tier.tierId}>
                <div className="flex w-full items-center justify-between gap-3 min-w-0">
                  <span className="font-medium">{tier.shortName}</span>
                  <span className="text-xs text-muted-foreground ml-2 shrink-0">
                    {downloaded
                      ? "✓ on disk"
                      : `~${tier.downloadGb} GB · ${tier.vramGb} GB VRAM`}
                  </span>
                </div>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>

      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <div className="flex-1 leading-relaxed">{selected.description}</div>
        <div className="shrink-0 space-y-0.5 text-right text-[10px]">
          <div className="text-muted-foreground/70">
            {selected.vramGb} GB VRAM
          </div>
          <div className="text-muted-foreground/70">
            {selected.downloadGb} GB download
          </div>
        </div>
      </div>

      {!selectedDownloaded && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onDownload(selected)}
            disabled={isDownloading && !selectedIsDownloading}
            aria-busy={selectedIsDownloading}
            className={cn(
              selectedIsDownloading && "pointer-events-none cursor-wait",
            )}
          >
            {selectedIsDownloading ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-2 h-3.5 w-3.5" />
            )}
            {selectedIsDownloading
              ? `Downloading ${selected.shortName}…`
              : `Download ${selected.shortName} (~${selected.downloadGb} GB)`}
          </Button>
          {selectedIsDownloading && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancelDownload}
              className="text-muted-foreground hover:text-rose-500"
            >
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function SegmentPicker<T extends string | number>({
  values,
  labels,
  selected,
  onSelect,
}: {
  values: T[];
  labels?: string[];
  selected: T;
  onSelect: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((v, i) => (
        <button
          key={String(v)}
          type="button"
          onClick={() => onSelect(v)}
          className={cn(
            "rounded border px-2.5 py-1 text-xs font-medium transition-colors",
            v === selected
              ? "border-primary/60 bg-primary/20 text-foreground"
              : "border-border bg-background/50 text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {labels?.[i] ?? String(v)}
        </button>
      ))}
    </div>
  );
}

// ImageSettingsPanel — resolution, steps, guidance, seed, quality presets.
// Pure controlled component; parent owns persistence (localStorage per tier).
function ImageSettingsPanel({
  tier,
  settings,
  onChange,
  onReset,
}: {
  tier: ImageTierUiConfig;
  settings: ImageSettings;
  onChange: (patch: Partial<ImageSettings>) => void;
  onReset: () => void;
}) {
  const stepValues: number[] = [];
  for (let s = tier.minSteps; s <= tier.maxSteps; s++) stepValues.push(s);

  const guidanceValues = [0, 1, 2, 3, 4, 5, 6, 7];

  return (
    <div className="space-y-5 rounded-lg border bg-muted/10 p-4">
      {/* Quality presets — quick picks */}
      <div className="space-y-2">
        <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Quick preset
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {tier.qualityPresets.map((preset) => {
            const active =
              preset.steps === settings.steps &&
              (!tier.supportsGuidance || preset.guidance === settings.guidance);
            return (
              <button
                key={preset.label}
                type="button"
                onClick={() =>
                  onChange({ steps: preset.steps, guidance: preset.guidance })
                }
                className={cn(
                  "rounded border px-2.5 py-1 text-xs font-medium transition-colors",
                  active
                    ? "border-primary/60 bg-primary/20 text-foreground"
                    : "border-border bg-background/50 text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Resolution */}
      <div className="space-y-2">
        <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Resolution
        </Label>
        <SegmentPicker
          values={tier.allowedResolutions.map((r) => `${r.width}x${r.height}`)}
          labels={tier.allowedResolutions.map((r) => r.label)}
          selected={`${settings.width}x${settings.height}`}
          onSelect={(v) => {
            const [w, h] = v.split("x").map(Number);
            onChange({ width: w, height: h });
          }}
        />
      </div>

      {/* Steps */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Steps
          </Label>
          <span className="text-xs text-muted-foreground">
            {settings.steps}
          </span>
        </div>
        <SegmentPicker
          values={stepValues}
          selected={settings.steps}
          onSelect={(v) => onChange({ steps: v })}
        />
        <p className="text-[11px] text-muted-foreground">
          More steps = higher quality, slower. {tier.shortName}: {tier.minSteps}
          –{tier.maxSteps} steps.
        </p>
      </div>

      {/* Guidance scale (only for models that support it) */}
      {tier.supportsGuidance && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Guidance scale
            </Label>
            <span className="text-xs text-muted-foreground">
              {settings.guidance}
            </span>
          </div>
          <SegmentPicker
            values={guidanceValues}
            selected={settings.guidance}
            onSelect={(v) => onChange({ guidance: v })}
          />
          <p className="text-[11px] text-muted-foreground">
            Higher = follows prompt more strictly. 3–5 works well for most
            prompts.
          </p>
        </div>
      )}

      {/* Seed */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Seed
          </Label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onChange({
                  seed:
                    settings.seed !== null
                      ? null
                      : Math.floor(Math.random() * 999999),
                })
              }
              className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
            >
              {settings.seed !== null ? "Switch to random" : "Fix seed"}
            </button>
            {settings.seed !== null && (
              <button
                type="button"
                onClick={() =>
                  onChange({ seed: Math.floor(Math.random() * 999999) })
                }
                className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
              >
                New seed
              </button>
            )}
          </div>
        </div>
        {settings.seed !== null ? (
          <input
            type="number"
            value={settings.seed}
            min={0}
            max={999999}
            onChange={(e) =>
              onChange({
                seed: Math.max(
                  0,
                  Math.min(999999, parseInt(e.target.value, 10) || 0),
                ),
              })
            }
            className="h-8 w-full rounded-md border border-border bg-background/50 px-3 text-xs text-foreground outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
          />
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Random seed on every generation. Fix it to reproduce the same image.
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={onReset}
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Reset to defaults
      </button>
    </div>
  );
}

// EventLogPanel — collapsible panel showing the in-page event log plus the
// tail of the backend stdout buffer (status.lastLog). Useful for debugging
// install / download / generation failures without leaving the page.
function EventLogPanel({
  entries,
  backendLog,
  open,
  onToggle,
}: {
  entries: EventLogEntry[];
  backendLog?: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center justify-between"
        >
          <CardTitle className="flex items-center gap-2 text-sm">
            <Terminal className="h-4 w-4" />
            Activity log
            <span className="text-xs font-normal text-muted-foreground">
              ({entries.length} event{entries.length === 1 ? "" : "s"})
            </span>
          </CardTitle>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              !open && "-rotate-90",
            )}
          />
        </button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 pt-0">
          <div className="max-h-48 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
            {entries.length === 0 ? (
              <p className="text-muted-foreground">
                No events yet. Logs appear here as you install, download, and
                generate.
              </p>
            ) : (
              entries
                .slice()
                .reverse()
                .map((entry) => (
                  <div key={entry.id} className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground">
                      {entry.time}
                    </span>
                    <span
                      className={cn(
                        entry.level === "error" && "text-rose-500",
                        entry.level === "success" && "text-emerald-500",
                      )}
                    >
                      {entry.message}
                    </span>
                  </div>
                ))
            )}
          </div>
          {backendLog && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Backend stdout (tail)
              </p>
              <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-relaxed">
                {backendLog}
              </pre>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function GenerationForm({
  promptId,
  prompt,
  setPrompt,
  placeholder,
  buttonText,
  buttonIcon,
  disabled,
  loading,
  onGenerate,
  onStop,
}: {
  promptId: string;
  prompt: string;
  setPrompt: (v: string) => void;
  placeholder: string;
  buttonText: string;
  buttonIcon: React.ReactNode;
  disabled: boolean;
  loading: boolean;
  onGenerate: () => void;
  onStop?: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={promptId}>Prompt</Label>
        <Textarea
          id={promptId}
          placeholder={placeholder}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
        />
      </div>
      {/* When `loading`, we deliberately do NOT set `disabled`: the Button
          variant applies `opacity-50` to disabled buttons, which in galaxy
          mode (cream bg + dark text on dark backdrop) makes the spinner and
          "Generating..." text both fade to mid-grey and become unreadable.
          We block clicks via `pointer-events-none` and mark `aria-busy` so
          assistive tech still sees it as busy. */}
      <div className="flex gap-2">
        <Button
          onClick={onGenerate}
          disabled={!loading && disabled}
          aria-busy={loading}
          className={cn("flex-1", loading && "pointer-events-none cursor-wait")}
        >
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            buttonIcon
          )}
          {loading ? "Generating..." : buttonText}
        </Button>
        {loading && onStop && (
          <Button variant="outline" onClick={onStop} title="Stop generation">
            <Square className="mr-2 h-4 w-4" />
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// LocalImage — renders a locally-generated image with a visible error state.
// A plain <img> fails silently when the server path is wrong; this surfaces it.
// -----------------------------------------------------------------------------

function LocalImage({ src }: { src: string }) {
  const [imgError, setImgError] = useState(false);

  if (imgError) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-rose-500/40 bg-rose-500/5 p-6 text-center text-sm">
        <p className="font-medium text-rose-500">
          Image generated but could not load
        </p>
        <p className="text-xs text-muted-foreground break-all">{src}</p>
        <p className="text-xs text-muted-foreground">
          Check the backend log in the Setup panel above for details.
        </p>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary underline"
        >
          Open directly in browser
        </a>
      </div>
    );
  }

  return (
    <div className="flex justify-center">
      <img
        src={src}
        alt="Generated"
        className="max-h-[512px] max-w-full rounded-lg border shadow-sm"
        onError={() => {
          console.error("[MediaAI] failed to load local image:", src);
          setImgError(true);
        }}
        onLoad={() => console.log("[MediaAI] local image loaded OK:", src)}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// VideoSlideshow — auto-cycling slideshow of cloud-generated keyframes. Used
// as a stand-in for true text-to-video, which has no good free no-auth API.
// -----------------------------------------------------------------------------

function VideoSlideshow({ frames }: { frames: string[] }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  // Map of frame index -> local blob URL (or null = still loading)
  const [blobs, setBlobs] = useState<(string | null)[]>(() =>
    frames.map(() => null),
  );
  const [errorCount, setErrorCount] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const FRAME_MS = 700;

  // Fetch every frame via the main-process IPC proxy (no CORS/Referer issues).
  // Cleans up old blob URLs on unmount or when frames change.
  useEffect(() => {
    let cancelled = false;
    const localBlobs: (string | null)[] = frames.map(() => null);
    setBlobs([...localBlobs]);
    setErrorCount(0);

    frames.forEach((url, i) => {
      ipc.mediaAi
        .fetchCloudImage({ url })
        .then(({ base64, contentType }) => {
          if (cancelled) return;
          const blob = base64ToBlob(base64, contentType);
          const blobUrl = URL.createObjectURL(blob);
          localBlobs[i] = blobUrl;
          setBlobs((prev) => {
            const next = [...prev];
            next[i] = blobUrl;
            return next;
          });
        })
        .catch(() => {
          if (cancelled) return;
          setErrorCount((n) => n + 1);
        });
    });

    return () => {
      cancelled = true;
      localBlobs.forEach((u) => u && URL.revokeObjectURL(u));
    };
  }, [frames]);

  const loadedCount = blobs.filter((b) => b !== null).length;

  // Auto-advance the playhead, skipping frames that haven't loaded yet
  useEffect(() => {
    if (!playing || loadedCount === 0) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => {
      setIndex((i) => {
        for (let step = 1; step <= frames.length; step++) {
          const next = (i + step) % frames.length;
          if (blobs[next]) return next;
        }
        return i;
      });
    }, FRAME_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, loadedCount, frames.length, blobs]);

  // Once at least one frame loads, snap to it
  useEffect(() => {
    if (loadedCount > 0 && blobs[index] == null) {
      const first = blobs.findIndex((b) => b !== null);
      if (first >= 0) setIndex(first);
    }
  }, [loadedCount, blobs, index]);

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="relative w-full max-w-2xl overflow-hidden rounded-lg border bg-black shadow-sm"
        style={{ aspectRatio: "16 / 9" }}
      >
        {blobs.map(
          (blobUrl, i) =>
            blobUrl && (
              <img
                key={i}
                src={blobUrl}
                alt={`Frame ${i + 1}`}
                className="absolute inset-0 h-full w-full object-cover transition-opacity duration-300"
                style={{ opacity: i === index ? 1 : 0 }}
              />
            ),
        )}
        {loadedCount === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-sm text-white">
            <Loader2 className="h-6 w-6 animate-spin" />
            Generating frames... (first one can take 10-30s)
          </div>
        )}
        {loadedCount > 0 && loadedCount < frames.length && (
          <div className="absolute bottom-10 right-2 rounded bg-black/60 px-2 py-1 text-[10px] text-white">
            {loadedCount} / {frames.length} loaded
          </div>
        )}
        <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1.5">
          {frames.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                if (blobs[i]) {
                  setIndex(i);
                  setPlaying(false);
                }
              }}
              disabled={!blobs[i]}
              className={`h-1.5 rounded-full transition-all disabled:opacity-30 ${
                i === index ? "w-6 bg-white" : "w-1.5 bg-white/50"
              }`}
              aria-label={`Frame ${i + 1}`}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          className="rounded-full border px-3 py-1 hover:bg-accent disabled:opacity-50"
          disabled={loadedCount === 0}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <span>
          Frame {index + 1} / {frames.length}
          {loadedCount < frames.length && ` - ${loadedCount} loaded`}
          {errorCount > 0 && ` - ${errorCount} failed`}
        </span>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// useBlobImage — fetches a remote image and exposes a local blob URL.
//
// We use the main-process IPC proxy (media-ai:fetch-cloud-image) instead of
// renderer-side fetch. The renderer can't reliably load Pollinations.ai
// because Electron sends an unblockable Referer that the host rejects with
// HTTP 403. The main process fetch has no such restriction, and we receive
// the bytes as base64 and turn them into a same-origin blob: URL for <img>.
// -----------------------------------------------------------------------------

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

function useBlobImage(src: string): {
  blobUrl: string | null;
  status: "loading" | "loaded" | "error";
  error: string | null;
  retry: () => void;
} {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setStatus("loading");
    setError(null);
    setBlobUrl(null);

    (async () => {
      try {
        const { base64, contentType } = await ipc.mediaAi.fetchCloudImage({
          url: src,
        });
        if (cancelled) return;
        const blob = base64ToBlob(base64, contentType);
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
        setStatus("loaded");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [src, attempt]);

  return {
    blobUrl,
    status,
    error,
    retry: () => setAttempt((a) => a + 1),
  };
}

// LoadingImage — wraps a cross-origin URL with the blob loader above plus a
// spinner / retry-on-error UI. Used for cloud Pollinations.ai output where
// first-byte time can be 10-30 seconds.

function LoadingImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const { blobUrl, status, error, retry } = useBlobImage(src);

  return (
    <div className="flex justify-center">
      {status === "loaded" && blobUrl && (
        <img src={blobUrl} alt={alt} className={className} />
      )}
      {status === "loading" && (
        <div className="flex h-72 w-[512px] max-w-full flex-col items-center justify-center gap-3 rounded-lg border bg-muted/30 text-sm text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" />
          <p>Generating... (first request can take 10-30s)</p>
        </div>
      )}
      {status === "error" && (
        <div className="flex h-72 w-[512px] max-w-full flex-col items-center justify-center gap-3 rounded-lg border border-rose-500/40 bg-rose-500/5 p-4 text-center text-sm">
          <p className="font-medium text-rose-500">Couldn't load the image</p>
          {error && <p className="text-xs text-muted-foreground">{error}</p>}
          <Button variant="secondary" size="sm" onClick={retry}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── SetupBanner — smart setup panel, collapses when backend is online ────────

function SetupBanner({
  phase,
  setupChainStep,
  setupChainModelId,
  setupError,
  status,
  hardware,
  backendHardware,
  orchStatus,
  availTiers,
  isDownloading,
  setupAction,
  showLog,
  eventLog,
  serverUrl,
  onOneClickSetup,
  onStartBackend,
  onStopBackend,
  onRefresh,
  onInstall,
  onToggleLog,
  onCancelDownload,
  onReinstallForGpu,
  onResetAndReinstall,
  onRetry,
}: {
  phase:
    | "checking"
    | "stopped"
    | "needs-setup"
    | "python-missing"
    | "setting-up"
    | "starting"
    | "stopping"
    | "online"
    | "error";
  setupChainStep: string | null;
  setupChainModelId: MediaAiModelId | null;
  setupError: string | null;
  status: MediaAiStatus | null;
  hardware: HardwareProfile | null;
  backendHardware: {
    backend: string;
    torch_device: string;
    vram_mb: number;
  } | null;
  orchStatus: OrchestratorStatus | null;
  availTiers: AvailableTiers | null;
  isDownloading: boolean;
  setupAction: string | null;
  showLog: boolean;
  eventLog: EventLogEntry[];
  serverUrl: string;
  onOneClickSetup: () => void;
  onStartBackend: () => void;
  onStopBackend: () => void;
  onRefresh: () => void;
  onInstall: () => void;
  onToggleLog: () => void;
  onCancelDownload: () => void;
  onReinstallForGpu: () => void;
  onResetAndReinstall: () => void;
  onRetry: () => void;
}) {
  // ── Online: compact status bar ───────────────────────────────────────────
  if (phase === "online") {
    const gpuExpected =
      hardware?.bestMediaBackend && hardware.bestMediaBackend !== "cpu";
    const runningOnCpu = backendHardware?.backend === "cpu";
    const showGpuWarning = gpuExpected && runningOnCpu;
    return (
      <div className="mb-6 flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-green-500/30 bg-green-500/5 px-4 py-3">
          <div className="flex items-center gap-3">
            <Server className="h-4 w-4 text-green-600" />
            <span className="text-sm font-medium text-green-700">
              Backend online
            </span>
            {backendHardware && (
              <BackendBadge backend={backendHardware.backend} />
            )}
            {hardware?.primaryGpu && hardware.primaryGpu.vramMb > 0 && (
              <span className="text-xs text-muted-foreground">
                {hardware.primaryGpu.model} ·{" "}
                {Math.round(hardware.primaryGpu.vramMb / 1024)} GB VRAM
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              className="h-7 px-2 text-xs"
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              Refresh
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onResetAndReinstall}
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              title="Wipe the Python environment and reinstall — useful if GPU isn't being used"
            >
              <Wrench className="mr-1 h-3 w-3" />
              Reset
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onStopBackend}
              className="h-7 px-2 text-xs text-muted-foreground hover:text-rose-500"
            >
              <Square className="mr-1 h-3 w-3" />
              Stop
            </Button>
          </div>
        </div>
        {showGpuWarning && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-yellow-500/40 bg-yellow-500/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-yellow-600" />
              <span className="text-sm text-yellow-700">
                Running on CPU — GPU torch not installed for{" "}
                {BACKEND_LABELS[hardware!.bestMediaBackend!] ??
                  hardware!.bestMediaBackend}
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 border-yellow-500/40 px-3 text-xs"
                onClick={onReinstallForGpu}
              >
                <Wrench className="mr-1.5 h-3 w-3" />
                Install GPU Support
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-3 text-xs text-muted-foreground hover:text-rose-500"
                onClick={onResetAndReinstall}
              >
                Reset &amp; Reinstall
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Checking ─────────────────────────────────────────────────────────────
  if (phase === "checking") {
    return (
      <div className="mb-6 flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Checking backend…</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          className="ml-auto h-7 px-2 text-xs"
        >
          <RefreshCw className="mr-1 h-3 w-3" />
          Refresh
        </Button>
      </div>
    );
  }

  // ── Starting (backend spawned, polling health) ────────────────────────────
  if (phase === "starting") {
    return (
      <div className="mb-6 flex items-center gap-3 rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3">
        <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
        <div className="flex flex-col">
          <span className="text-sm font-medium text-blue-700">
            Starting backend…
          </span>
          <span className="text-xs text-muted-foreground">
            Python server warming up — this can take 10–30 s
          </span>
        </div>
      </div>
    );
  }

  // ── Stopping ──────────────────────────────────────────────────────────────
  if (phase === "stopping") {
    return (
      <div className="mb-6 flex items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Stopping backend…</span>
      </div>
    );
  }

  // ── Stopped (venv exists, not running) ───────────────────────────────────
  if (phase === "stopped") {
    const gpuBackend =
      hardware?.bestMediaBackend && hardware.bestMediaBackend !== "cpu"
        ? hardware.bestMediaBackend
        : null;
    const gpuAlreadyInstalled = !!status?.gpuBackendInstalled;
    return (
      <div className="mb-6 flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-3">
            <ServerOff className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Backend stopped
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              className="h-7 px-2 text-xs"
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              Refresh
            </Button>
            <Button
              size="sm"
              onClick={onStartBackend}
              className="h-7 px-3 text-xs"
            >
              <Play className="mr-1.5 h-3 w-3" />
              Start Backend
            </Button>
          </div>
        </div>
        {gpuBackend && !gpuAlreadyInstalled && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-yellow-500/40 bg-yellow-500/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-yellow-600" />
              <span className="text-sm text-yellow-700">
                GPU detected ({BACKEND_LABELS[gpuBackend] ?? gpuBackend}) —
                install GPU support to run on your graphics card
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-yellow-500/40 px-3 text-xs"
              onClick={onReinstallForGpu}
            >
              <Wrench className="mr-1.5 h-3 w-3" />
              Install GPU Support
            </Button>
          </div>
        )}
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <Card className="mb-6 border-rose-500/40">
        <CardContent className="pt-6">
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <ServerOff className="mt-0.5 h-5 w-5 shrink-0 text-rose-500" />
              <div>
                <p className="font-medium text-rose-600">Setup failed</p>
                {setupError && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {setupError}
                  </p>
                )}
                {setupError?.includes("python.org") && (
                  <a
                    href="https://www.python.org/downloads/"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-sm text-primary underline"
                  >
                    Download Python →
                  </a>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={onRetry}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                Try Again
              </Button>
              <Button variant="outline" size="sm" onClick={onToggleLog}>
                <Terminal className="mr-2 h-3.5 w-3.5" />
                {showLog ? "Hide Log" : "Show Log"}
              </Button>
            </div>
            {showLog && (
              <div className="max-h-48 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
                {eventLog
                  .slice()
                  .reverse()
                  .map((e) => (
                    <div key={e.id} className="flex gap-2">
                      <span className="shrink-0 text-muted-foreground">
                        {e.time}
                      </span>
                      <span
                        className={cn(
                          e.level === "error" && "text-rose-500",
                          e.level === "success" && "text-emerald-500",
                        )}
                      >
                        {e.message}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Setting up (chain running) ────────────────────────────────────────────
  if (phase === "setting-up") {
    const steps = [
      { id: "install", label: "Install Python packages" },
      { id: "download", label: "Download all media models" },
      { id: "start", label: "Start backend server" },
    ];
    // Same ordering as runSetupChain so the per-component sub-list matches the
    // sequence the chain actually runs.
    const COMPONENTS: { id: MediaAiModelId; label: string; sizeGb: number }[] =
      [
        { id: "whisper", label: "Whisper Base (transcription)", sizeGb: 0.15 },
        { id: "audio", label: "SpeechT5 + MMS-TTS (audio)", sizeGb: 1.0 },
        { id: "image-sd-turbo", label: "SD Turbo (image)", sizeGb: 2.5 },
        {
          id: "image-z-image-turbo",
          label: "Z-Image Turbo (image)",
          sizeGb: 6.0,
        },
        {
          id: "image",
          label: "Stable Diffusion 1.5 ONNX (image)",
          sizeGb: 4.0,
        },
        { id: "text", label: "Phi-3 mini (text)", sizeGb: 2.4 },
        { id: "video", label: "ModelScope text-to-video", sizeGb: 11.0 },
      ];
    const stepOrder = ["install", "download", "start"];
    const currentIdx = stepOrder.indexOf(setupChainStep ?? "");
    const activeComponentIdx = setupChainModelId
      ? COMPONENTS.findIndex((c) => c.id === setupChainModelId)
      : -1;
    return (
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Loader2 className="h-4 w-4 animate-spin" />
            Setting up Media AI…
          </CardTitle>
          {hardware?.bestMediaBackend && (
            <CardDescription className="flex items-center gap-2">
              Installing with{" "}
              <BackendBadge backend={hardware.bestMediaBackend} /> support
              {hardware.primaryGpu?.model
                ? ` on ${hardware.primaryGpu.model}`
                : ""}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            {steps.map((step, i) => {
              const stepIdx = stepOrder.indexOf(step.id);
              const isDone = currentIdx > stepIdx;
              const isActive = step.id === setupChainStep;
              return (
                <div key={step.id}>
                  <div className="flex items-center gap-2.5 text-sm">
                    {isDone ? (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-500 text-[10px] font-bold">
                        ✓
                      </span>
                    ) : isActive ? (
                      <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    ) : (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground">
                        {i + 1}
                      </span>
                    )}
                    <span
                      className={cn(
                        isDone && "text-muted-foreground line-through",
                        isActive && "font-medium",
                      )}
                    >
                      {step.label}
                    </span>
                  </div>
                  {step.id === "download" && (isActive || isDone) && (
                    <div className="ml-7 mt-1.5 space-y-1 border-l border-border/50 pl-3">
                      {COMPONENTS.map((c, ci) => {
                        const downloaded =
                          status?.models.some(
                            (m) => m.id === c.id && m.downloaded,
                          ) ?? false;
                        const isComponentActive =
                          isActive && ci === activeComponentIdx;
                        const isComponentDone =
                          downloaded ||
                          (isActive &&
                            activeComponentIdx >= 0 &&
                            ci < activeComponentIdx) ||
                          isDone;
                        return (
                          <div
                            key={c.id}
                            className="flex items-center gap-2 text-xs"
                          >
                            {isComponentDone ? (
                              <span className="text-emerald-500">✓</span>
                            ) : isComponentActive ? (
                              <Loader2 className="h-3 w-3 animate-spin text-primary" />
                            ) : (
                              <span className="text-muted-foreground">•</span>
                            )}
                            <span
                              className={cn(
                                "flex-1",
                                isComponentDone && "text-muted-foreground",
                                isComponentActive && "font-medium",
                              )}
                            >
                              {c.label}
                            </span>
                            <span className="text-muted-foreground">
                              ~{c.sizeGb} GB
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {isDownloading && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancelDownload}
              className="text-muted-foreground hover:text-rose-500"
            >
              Cancel download
            </Button>
          )}
          <button
            type="button"
            onClick={onToggleLog}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Terminal className="h-3 w-3" />
            {showLog ? "Hide" : "Show"} activity log
          </button>
          {showLog && (
            <div className="max-h-48 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
              {eventLog.length === 0 ? (
                <p className="text-muted-foreground">No events yet.</p>
              ) : (
                eventLog
                  .slice()
                  .reverse()
                  .map((e) => (
                    <div key={e.id} className="flex gap-2">
                      <span className="shrink-0 text-muted-foreground">
                        {e.time}
                      </span>
                      <span
                        className={cn(
                          e.level === "error" && "text-rose-500",
                          e.level === "success" && "text-emerald-500",
                        )}
                      >
                        {e.message}
                      </span>
                    </div>
                  ))
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // ── Needs setup (no venv) ─────────────────────────────────────────────────
  // Components downloaded by the one-click chain. Keep this in sync with
  // runSetupChain in MediaAIPage and the COMPONENTS list above.
  const ALL_COMPONENT_SUMMARY: {
    id: MediaAiModelId;
    label: string;
    sizeGb: number;
  }[] = [
    { id: "whisper", label: "Whisper (transcribe)", sizeGb: 0.15 },
    { id: "audio", label: "SpeechT5 + MMS-TTS (audio)", sizeGb: 1.0 },
    { id: "image-sd-turbo", label: "SD Turbo", sizeGb: 2.5 },
    { id: "image-z-image-turbo", label: "Z-Image Turbo", sizeGb: 6.0 },
    { id: "image", label: "Stable Diffusion 1.5", sizeGb: 4.0 },
    { id: "text", label: "Phi-3 mini (text)", sizeGb: 2.4 },
    { id: "video", label: "Text-to-video", sizeGb: 11.0 },
  ];
  const pendingComponents = ALL_COMPONENT_SUMMARY.filter(
    (c) =>
      !(status?.models.some((m) => m.id === c.id && m.downloaded) ?? false),
  );
  const totalGb = pendingComponents.reduce((acc, c) => acc + c.sizeGb, 0);
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          Set Up Media AI
        </CardTitle>
        <CardDescription>
          One click installs the Python runtime with GPU support (when
          available), downloads every media model, and launches the local
          backend.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Hardware detected */}
        {hardware && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/20 px-4 py-3 text-sm">
            <Zap className="h-4 w-4 text-muted-foreground" />
            {hardware.primaryGpu?.model ? (
              <>
                <span className="font-medium">{hardware.primaryGpu.model}</span>
                {hardware.primaryGpu.vramMb > 0 && (
                  <span className="text-muted-foreground">
                    · {Math.round(hardware.primaryGpu.vramMb / 1024)} GB VRAM
                  </span>
                )}
                {hardware.bestMediaBackend && (
                  <BackendBadge backend={hardware.bestMediaBackend} />
                )}
              </>
            ) : (
              <span className="text-muted-foreground">
                No dedicated GPU detected — CPU mode
              </span>
            )}
          </div>
        )}

        {/* What will be downloaded */}
        <div className="rounded-lg border bg-muted/20 px-4 py-3 text-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-medium">
              {pendingComponents.length === 0
                ? "All media models already installed"
                : `${pendingComponents.length} model${pendingComponents.length === 1 ? "" : "s"} to download`}
            </span>
            {pendingComponents.length > 0 && (
              <span className="text-xs text-muted-foreground">
                ~{totalGb.toFixed(1)} GB total
              </span>
            )}
          </div>
          {pendingComponents.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {ALL_COMPONENT_SUMMARY.map((c) => {
                const downloaded =
                  status?.models.some((m) => m.id === c.id && m.downloaded) ??
                  false;
                return (
                  <li key={c.id} className="flex items-center gap-2">
                    <span
                      className={
                        downloaded
                          ? "text-emerald-500"
                          : "text-muted-foreground"
                      }
                    >
                      {downloaded ? "✓" : "•"}
                    </span>
                    <span
                      className={cn("flex-1", downloaded && "line-through")}
                    >
                      {c.label}
                    </span>
                    <span>~{c.sizeGb} GB</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Primary CTA */}
        <Button
          size="lg"
          className="w-full"
          onClick={onOneClickSetup}
          disabled={!status?.backendAvailable}
        >
          <Wrench className="mr-2 h-4 w-4" />
          {pendingComponents.length === 0
            ? "Launch Media AI"
            : `Install & Download Everything (~${totalGb.toFixed(2)} GB)`}
        </Button>
        {!status?.backendAvailable && (
          <p className="text-xs text-muted-foreground text-center">
            Backend files not found. Check that the mediaai-backend folder is
            present.
          </p>
        )}

        {/* Advanced / manual controls */}
        <details className="group">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground select-none">
            Advanced options
          </summary>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={onRefresh}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" /> Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onInstall}
              disabled={setupAction !== null || !status?.backendAvailable}
            >
              {setupAction === "install" ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="mr-2 h-3.5 w-3.5" />
              )}
              Install Deps Only
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onStartBackend}
              disabled={setupAction !== null || !status?.backendAvailable}
            >
              {setupAction === "start" ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-2 h-3.5 w-3.5" />
              )}
              Start Backend
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onResetAndReinstall}
              disabled={setupAction !== null || !status?.venvExists}
              className="text-muted-foreground hover:text-foreground"
              title="Delete the Python environment and reinstall — keeps downloaded models"
            >
              <Wrench className="mr-2 h-3.5 w-3.5" />
              Reset &amp; Reinstall
            </Button>
          </div>
          <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
            <StatusRow label="Backend" value={status?.backendPath} />
            <StatusRow
              label="Python env"
              value={status?.venvExists ? status.pythonPath : "Not installed"}
            />
            <StatusRow label="Models" value={status?.modelsPath} />
            <StatusRow label="Server" value={serverUrl} />
          </div>
          {orchStatus && (
            <div className="mt-2">
              <StatusRow label="Orchestrator" value={orchStatus.state} />
            </div>
          )}
          {availTiers && (
            <div className="mt-3 grid gap-2 md:grid-cols-3">
              <TierRow label="Image" tier={availTiers.image?.[0] ?? null} />
              <TierRow label="Audio" tier={availTiers.audio?.[0] ?? null} />
              <TierRow label="Video" tier={availTiers.video?.[0] ?? null} />
            </div>
          )}
        </details>

        {/* Log */}
        {(showLog || setupAction !== null) && (
          <>
            <button
              type="button"
              onClick={onToggleLog}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <Terminal className="h-3 w-3" />
              {showLog ? "Hide" : "Show"} activity log
            </button>
            {showLog && (
              <div className="max-h-48 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed">
                {eventLog.length === 0 ? (
                  <p className="text-muted-foreground">No events yet.</p>
                ) : (
                  eventLog
                    .slice()
                    .reverse()
                    .map((e) => (
                      <div key={e.id} className="flex gap-2">
                        <span className="shrink-0 text-muted-foreground">
                          {e.time}
                        </span>
                        <span
                          className={cn(
                            e.level === "error" && "text-rose-500",
                            e.level === "success" && "text-emerald-500",
                          )}
                        >
                          {e.message}
                        </span>
                      </div>
                    ))
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
