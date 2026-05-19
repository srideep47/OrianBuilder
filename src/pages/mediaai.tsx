import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import {
  ChevronDown,
  Cpu,
  Download,
  FileAudio,
  Image,
  Loader2,
  Mic,
  Music,
  Play,
  RefreshCw,
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
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type MediaTab = "image" | "audio" | "transcribe" | "video";

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

const TIER_PREF_KEY = "mediaai:image:tier";
const SETTINGS_KEY = "mediaai:image:settings-by-tier";

function loadStoredTierId(): string {
  if (typeof window === "undefined") return USER_FACING_IMAGE_TIERS[0].tierId;
  const v = window.localStorage.getItem(TIER_PREF_KEY);
  if (v && USER_FACING_IMAGE_TIERS.some((t) => t.tierId === v)) return v;
  return USER_FACING_IMAGE_TIERS[0].tierId;
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
  const [isDownloading, setIsDownloading] = useState(false);
  // Hardware as seen by the Python backend (may differ from Electron's view
  // if the backend started before CUDA detection finished).
  const [backendHardware, setBackendHardware] = useState<{
    backend: string;
    torch_device: string;
    vram_mb: number;
  } | null>(null);

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

  // One-button setup: install deps (if missing) → download the currently-
  // selected image model (if missing) → start backend (if not running).
  // Each step is skipped when already satisfied, so re-running is safe.
  const runSetupChain = useCallback(async () => {
    try {
      if (!status?.venvExists) {
        setSetupChainStep("install");
        appendLog("Installing Python dependencies…");
        const backend = hardware?.bestMediaBackend ?? undefined;
        await ipc.mediaAi.installDependenciesForBackend({ backend });
        appendLog("Dependencies installed.", "success");
      }
      if (!tierDownloaded(selectedImageTier.downloadId)) {
        setSetupChainStep("download");
        setIsDownloading(true);
        appendLog(
          `Downloading ${selectedImageTier.shortName} (~${selectedImageTier.downloadGb} GB)…`,
        );
        try {
          await ipc.mediaAi.downloadModels({
            models: [selectedImageTier.downloadId as MediaAiModelId],
          });
          appendLog(`${selectedImageTier.shortName} downloaded.`, "success");
        } finally {
          setIsDownloading(false);
        }
      }
      if (!isBackendOnline) {
        setSetupChainStep("start");
        appendLog("Starting backend…");
        await ipc.mediaAi.startBackend(undefined);
        appendLog("Backend online.", "success");
      }
      toast.success("Media AI ready");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      appendLog(`Setup failed: ${msg}`, "error");
      toast.error(msg);
    } finally {
      setSetupChainStep(null);
      await refreshAll();
    }
  }, [
    status,
    hardware,
    isBackendOnline,
    selectedImageTier,
    tierDownloaded,
    appendLog,
    refreshAll,
  ]);

  const installDependencies = () =>
    runSetupAction("install", async () => {
      const backend = hardware?.bestMediaBackend ?? undefined;
      await ipc.mediaAi.installDependenciesForBackend({ backend });
      toast.success("Media AI dependencies installed");
    });

  const startBackend = () =>
    runSetupAction("start", async () => {
      await ipc.mediaAi.startBackend(undefined);
      toast.success("Media AI backend started");
    });

  const stopBackend = () =>
    runSetupAction("stop", async () => {
      await ipc.mediaAi.stopBackend(undefined);
      toast.success("Media AI backend stopped");
    });

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      toast.error("Please enter a prompt");
      return;
    }

    setIsGenerating(true);
    setResult(null);

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
          if (!imgResp.ok) throw new Error(`Failed to fetch image: HTTP ${imgResp.status}`);
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
          toast.success(`Image generated locally${data.tier ? ` (${data.tier})` : ""}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          appendLog(`Generation failed: ${msg}`, "error");
          toast.error(msg);
        } finally {
          setIsGenerating(false);
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
        toast.info("Backend offline — using cloud fallback. Start the backend to generate locally.");
        setIsGenerating(false);
      }
      return;
    }

    if (activeTab === "video") {
      if (isBackendOnline) {
        toast.info("Generating video locally… first run downloads the model (~11GB) and may take 10–15 minutes.");
        try {
          const response = await fetch(`${serverUrl}/v1/generate/video`, {
            method: "POST",
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
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          setIsGenerating(false);
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
        toast.info("Backend offline — using cloud fallback. Start the backend to generate locally.");
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
      console.error("Generation error:", error);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setIsGenerating(false);
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

  return (
    <div className="h-full w-full overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="flex items-center text-3xl font-bold">
              <Sparkles className="mr-3 h-8 w-8 text-primary" />
              Media AI
            </h1>
            <p className="mt-2 text-muted-foreground">
              Local image, audio, transcription, and video generation — hardware
              accelerated.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                isBackendOnline
                  ? "border-green-500/30 text-green-600"
                  : "border-red-500/30 text-red-600",
              )}
            >
              {isBackendOnline ? (
                <Server className="h-4 w-4" />
              ) : (
                <ServerOff className="h-4 w-4" />
              )}
              {isBackendOnline ? "Backend online" : "Backend offline"}
            </div>
            {hardware?.primaryGpu && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Zap className="h-3 w-3" />
                {hardware.primaryGpu.model}
                {hardware.primaryGpu.vramMb > 0 && (
                  <span>
                    · {Math.round(hardware.primaryGpu.vramMb / 1024)} GB VRAM
                  </span>
                )}
                {hardware.bestMediaBackend && (
                  <BackendBadge backend={hardware.bestMediaBackend} />
                )}
              </div>
            )}
          </div>
        </div>

        {/* Setup Card */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wrench className="h-5 w-5" />
              Backend Setup
            </CardTitle>
            <CardDescription>
              Install the Python runtime for your GPU, download model groups,
              and control the FastAPI server.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 text-sm md:grid-cols-2">
              <StatusRow label="Backend" value={status?.backendPath} />
              <StatusRow label="Models" value={status?.modelsPath} />
              <StatusRow
                label="Python environment"
                value={status?.venvExists ? status.pythonPath : "Not installed"}
              />
              <StatusRow label="Server" value={serverUrl} />
              {hardware && (
                <StatusRow
                  label="GPU backend (Electron)"
                  value={
                    hardware.bestMediaBackend
                      ? `${BACKEND_LABELS[hardware.bestMediaBackend] ?? hardware.bestMediaBackend} — ${hardware.primaryGpu?.model ?? "unknown GPU"}`
                      : "CPU only"
                  }
                />
              )}
              {backendHardware && (
                <StatusRow
                  label="GPU backend (Python)"
                  value={`${backendHardware.backend.toUpperCase()} · device=${backendHardware.torch_device} · ${Math.round(backendHardware.vram_mb / 1024)} GB VRAM`}
                />
              )}
              {orchStatus && (
                <StatusRow label="Orchestrator" value={orchStatus.state} />
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {/* One-button setup chain — installs deps, downloads the
                  selected image model, and starts the backend if any of
                  those is still missing. Re-runnable: each step is skipped
                  when already satisfied. */}
              <Button
                onClick={() => void runSetupChain()}
                disabled={
                  setupChainStep !== null || !status?.backendAvailable
                }
                aria-busy={setupChainStep !== null}
                className={cn(
                  setupChainStep !== null && "pointer-events-none cursor-wait",
                )}
              >
                {setupChainStep !== null ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Wrench className="mr-2 h-4 w-4" />
                )}
                {setupChainStep === "install"
                  ? "Installing dependencies…"
                  : setupChainStep === "download"
                    ? `Downloading ${selectedImageTier.shortName}…`
                    : setupChainStep === "start"
                      ? "Starting backend…"
                      : "Setup Media AI"}
              </Button>

              <Button
                variant="outline"
                onClick={() => void refreshAll()}
                disabled={setupAction !== null || setupChainStep !== null}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
              <Button
                variant="outline"
                onClick={() => void installDependencies()}
                disabled={
                  setupAction !== null ||
                  setupChainStep !== null ||
                  !status?.backendAvailable
                }
              >
                {setupAction === "install" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                Install
                {hardware?.bestMediaBackend
                  ? ` (${BACKEND_LABELS[hardware.bestMediaBackend] ?? hardware.bestMediaBackend})`
                  : " Dependencies"}
              </Button>
              {isBackendOnline && backendHardware?.torch_device === "cpu" && (
                <Button
                  variant="outline"
                  title="The pipeline was loaded on CPU. Click to flush it and reload on GPU."
                  onClick={() => {
                    void fetch(`${serverUrl}/v1/pipeline/unload`, {
                      method: "POST",
                    }).then(() => {
                      appendLog("Pipeline flushed — next generation will reload on GPU.", "success");
                      toast.success("Pipeline reloaded — GPU will be used on next generation");
                    });
                  }}
                  disabled={setupAction !== null || setupChainStep !== null}
                >
                  <Zap className="mr-2 h-4 w-4" />
                  Reload GPU Pipeline
                </Button>
              )}
              {isBackendOnline ? (
                <Button
                  variant="outline"
                  onClick={() => void stopBackend()}
                  disabled={setupAction !== null || setupChainStep !== null}
                >
                  <Square className="mr-2 h-4 w-4" />
                  Stop Backend
                </Button>
              ) : (
                <Button
                  onClick={() => void startBackend()}
                  disabled={
                    (setupAction !== null && setupAction !== "start") ||
                    setupChainStep !== null ||
                    !status?.backendAvailable
                  }
                  aria-busy={setupAction === "start"}
                  className={cn(
                    setupAction === "start" && "pointer-events-none cursor-wait",
                  )}
                >
                  {setupAction === "start" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="mr-2 h-4 w-4" />
                  )}
                  {setupAction === "start" ? "Starting…" : "Start Backend"}
                </Button>
              )}
            </div>

            {availTiers && (
              <>
                <Separator />
                <div>
                  <p className="mb-3 text-sm font-medium">
                    Available tiers
                    {availTiers.projectedAvailableVramMb > 0 && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        (~
                        {Math.round(
                          availTiers.projectedAvailableVramMb / 1024,
                        )}{" "}
                        GB projected free VRAM)
                      </span>
                    )}
                  </p>
                  <div className="grid gap-2 md:grid-cols-3">
                    <TierRow label="Image" tier={bestTier("image")} />
                    <TierRow label="Audio" tier={bestTier("audio")} />
                    <TierRow label="Video" tier={bestTier("video")} />
                  </div>
                </div>
              </>
            )}

            {status?.lastLog && (
              <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-3 text-xs">
                {status.lastLog}
              </pre>
            )}
          </CardContent>
        </Card>

        {/* Generation Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => {
            setActiveTab(v as MediaTab);
            setResult(null);
          }}
        >
          <TabsList className="grid w-full grid-cols-4">
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
          </TabsList>

          {/* Image */}
          <TabsContent value="image" className="mt-6 space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle>Image Generation</CardTitle>
                    <CardDescription>
                      Pick a model that fits your hardware. Settings persist
                      per model across sessions.
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
                />
              </CardContent>
            </Card>
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
  isDownloading,
  downloadingTierId,
}: {
  selectedTierId: string;
  onSelect: (tierId: string) => void;
  tiers: readonly ImageTierUiConfig[];
  isTierDownloaded: (downloadId: string) => boolean;
  onDownload: (tier: ImageTierUiConfig) => void;
  onCancelDownload: () => void;
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
          <span className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-500">
            Downloaded
          </span>
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
          <div className="text-muted-foreground/70">{selected.vramGb} GB VRAM</div>
          <div className="text-muted-foreground/70">{selected.downloadGb} GB download</div>
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
          <span className="text-xs text-muted-foreground">{settings.steps}</span>
        </div>
        <SegmentPicker
          values={stepValues}
          selected={settings.steps}
          onSelect={(v) => onChange({ steps: v })}
        />
        <p className="text-[11px] text-muted-foreground">
          More steps = higher quality, slower. {tier.shortName}: {tier.minSteps}–{tier.maxSteps} steps.
        </p>
      </div>

      {/* Guidance scale (only for models that support it) */}
      {tier.supportsGuidance && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Guidance scale
            </Label>
            <span className="text-xs text-muted-foreground">{settings.guidance}</span>
          </div>
          <SegmentPicker
            values={guidanceValues}
            selected={settings.guidance}
            onSelect={(v) => onChange({ guidance: v })}
          />
          <p className="text-[11px] text-muted-foreground">
            Higher = follows prompt more strictly. 3–5 works well for most prompts.
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
              onChange({ seed: Math.max(0, Math.min(999999, parseInt(e.target.value, 10) || 0)) })
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
      <Button
        onClick={onGenerate}
        disabled={!loading && disabled}
        aria-busy={loading}
        className={cn(
          "w-full",
          loading && "pointer-events-none cursor-wait",
        )}
      >
        {loading ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          buttonIcon
        )}
        {loading ? "Generating..." : buttonText}
      </Button>
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
        <p className="font-medium text-rose-500">Image generated but could not load</p>
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
