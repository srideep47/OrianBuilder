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
  filename?: string;
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
    if (!isBackendOnline) {
      toast.error("Start the Media AI backend first.");
      return;
    }

    setIsGenerating(true);
    setResult(null);

    try {
      let endpoint = "";
      let body: Record<string, unknown> = { prompt: prompt.trim() };

      if (activeTab === "image") {
        endpoint = "/v1/generate/image";
      } else if (activeTab === "audio") {
        endpoint = "/v1/generate/audio/tts";
        body = { text: prompt.trim() };
      } else if (activeTab === "video") {
        endpoint = "/v1/generate/video";
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
    if (!result?.url) return;
    const link = document.createElement("a");
    link.href = `${serverUrl}${result.url}`;
    link.download = result.filename ?? `generated-${activeTab}`;
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

    return (
      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>
              {result.tab === "transcribe"
                ? "Transcription"
                : `Generated ${result.tab}`}
            </CardTitle>
            <CardDescription>
              {result.tab === "transcribe"
                ? "Speech-to-text output"
                : "Your AI-generated content is ready"}
            </CardDescription>
          </div>
          {result.url && (
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
          {result.tab === "image" && result.url && (
            <div className="flex justify-center">
              <img
                src={`${serverUrl}${result.url}`}
                alt="Generated"
                className="max-h-[420px] max-w-full rounded-lg border shadow-sm"
              />
            </div>
          )}
          {result.tab === "audio" && result.url && (
            <audio controls className="w-full">
              <source src={`${serverUrl}${result.url}`} type="audio/wav" />
            </audio>
          )}
          {result.tab === "video" && result.url && (
            <video controls className="max-h-[420px] w-full rounded-lg border">
              <source src={`${serverUrl}${result.url}`} type="video/mp4" />
            </video>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="w-full px-4 py-6 sm:px-6 lg:px-8">
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
