import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import {
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
  Sparkles,
  Square,
  Upload,
  Video,
  Wrench,
  Zap,
} from "lucide-react";
import {
  ipc,
  type AvailableTiers,
  type HardwareProfile,
  type MediaAiStatus,
  type MediaTier,
  type OrchestratorStatus,
} from "@/ipc/types";
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

    // Image & Video: cloud-first via Pollinations.ai (no backend required).
    // This bypasses the Python ONNX pipeline that fails on Python 3.14.
    //
    // Pollinations generates server-side and can take 10-30s for the first
    // request. We DON'T probe the URL — the probe was unreliable because img
    // onerror can fire for slow first-byte time, transient network blips, or
    // when the renderer aborts. Instead we set the result immediately and let
    // the actual <img> tag in the result card handle loading + error display.
    if (activeTab === "image") {
      const url = pollinationsUrl(prompt.trim(), { width: 768, height: 768 });
      setResult({
        tab: "image",
        absoluteUrl: url,
        filename: `image-${Date.now()}.jpg`,
        source: "cloud",
      });
      toast.success("Generating image — first request can take 10-30s");
      setIsGenerating(false);
      return;
    }

    if (activeTab === "video") {
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
      toast.success("Generating frames — first one can take 10-30s");
      setIsGenerating(false);
      return;
    }

    // Text & Audio still require the local backend
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
          {result.tab === "image" && imageSrc && (
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
                  label="GPU backend"
                  value={
                    hardware.bestMediaBackend
                      ? `${BACKEND_LABELS[hardware.bestMediaBackend] ?? hardware.bestMediaBackend} — ${hardware.primaryGpu?.model ?? "unknown GPU"}`
                      : "CPU only"
                  }
                />
              )}
              {orchStatus && (
                <StatusRow label="Orchestrator" value={orchStatus.state} />
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => void refreshAll()}
                disabled={setupAction !== null}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
              <Button
                variant="outline"
                onClick={() => void installDependencies()}
                disabled={setupAction !== null || !status?.backendAvailable}
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
              {isBackendOnline ? (
                <Button
                  variant="outline"
                  onClick={() => void stopBackend()}
                  disabled={setupAction !== null}
                >
                  <Square className="mr-2 h-4 w-4" />
                  Stop Backend
                </Button>
              ) : (
                <Button
                  onClick={() => void startBackend()}
                  disabled={setupAction !== null || !status?.backendAvailable}
                >
                  {setupAction === "start" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="mr-2 h-4 w-4" />
                  )}
                  Start Backend
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
          <TabsContent value="image" className="mt-6">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle>Image Generation</CardTitle>
                    <CardDescription>
                      Generate images with Stable Diffusion — tier selected by
                      available VRAM.
                    </CardDescription>
                  </div>
                  <TierBadge tier={bestTier("image")} />
                </div>
              </CardHeader>
              <CardContent>
                <GenerationForm
                  promptId="image-prompt"
                  prompt={prompt}
                  setPrompt={setPrompt}
                  placeholder="A futuristic city at sunset with neon reflections..."
                  buttonText="Generate Image"
                  buttonIcon={<Image className="mr-2 h-4 w-4" />}
                  disabled={isGenerating || !prompt.trim() || !isBackendOnline}
                  loading={isGenerating && activeTab === "image"}
                  onGenerate={() => void handleGenerate()}
                />
              </CardContent>
            </Card>
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
                    disabled={
                      isGenerating || !transcribeFile || !isBackendOnline
                    }
                    className="w-full"
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
                  disabled={isGenerating || !prompt.trim() || !isBackendOnline}
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
      <Button onClick={onGenerate} disabled={disabled} className="w-full">
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
