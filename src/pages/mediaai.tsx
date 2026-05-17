import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import {
  CheckCircle2,
  Download,
  Image,
  Loader2,
  MessageSquare,
  Music,
  Play,
  RefreshCw,
  Send,
  Server,
  ServerOff,
  Sparkles,
  Square,
  Video,
  Wrench,
} from "lucide-react";
import { ipc, type MediaAiModelId, type MediaAiStatus } from "@/ipc/types";
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

type GenerationType = "text" | "image" | "audio" | "video";

interface GenerationResult {
  type: GenerationType;
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

const MODEL_SIZE_HINTS: Record<MediaAiModelId, string> = {
  text: "Phi-3 GGUF, around 2 GB",
  image: "Stable Diffusion ONNX, several GB",
  audio: "SpeechT5 + HiFi-GAN, under 1 GB",
  video: "Text-to-video, very large",
};

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
  const [activeTab, setActiveTab] = useState<GenerationType>("text");
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [status, setStatus] = useState<MediaAiStatus | null>(null);
  const [setupAction, setSetupAction] = useState<string | null>(null);

  const serverUrl = status?.serverUrl ?? "http://127.0.0.1:8000";
  const isBackendOnline = status?.healthy === true;

  const refreshStatus = useCallback(async () => {
    const nextStatus = await ipc.mediaAi.getStatus(undefined);
    setStatus(nextStatus);
  }, []);

  useEffect(() => {
    void refreshStatus();
    const interval = setInterval(() => void refreshStatus(), 30000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const runSetupAction = async (
    actionName: string,
    action: () => Promise<void>,
  ) => {
    setSetupAction(actionName);
    try {
      await action();
      await refreshStatus();
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSetupAction(null);
    }
  };

  const installDependencies = () =>
    runSetupAction("install", async () => {
      await ipc.mediaAi.installDependencies(undefined);
      toast.success("Media AI dependencies installed");
    });

  const downloadModels = (models: MediaAiModelId[]) =>
    runSetupAction(`download:${models.join(",")}`, async () => {
      await ipc.mediaAi.downloadModels({ models });
      toast.success("Model download completed");
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
        type: "image",
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
        type: "video",
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
      const response = await fetch(`${serverUrl}/generate/${activeTab}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ detail: `HTTP ${response.status}` }));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
      }

      const data = await response.json();
      setResult({
        type: activeTab,
        content: data.text || data.response,
        url: data.image_url || data.audio_url || data.video_url,
        filename: data.filename,
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
    link.download = result.filename || `generated-${activeTab}`;
    link.target = "_blank";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
              Generated {result.type}
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
              Your AI-generated content is ready
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
          {result.type === "text" && result.content && (
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="whitespace-pre-wrap text-sm leading-6">
                {result.content}
              </p>
            </div>
          )}
          {result.type === "image" && imageSrc && (
            <LoadingImage
              src={imageSrc}
              alt="Generated"
              className="max-h-[512px] max-w-full rounded-lg border shadow-sm"
            />
          )}
          {result.type === "audio" && result.url && (
            <audio controls className="w-full">
              <source src={`${serverUrl}${result.url}`} type="audio/wav" />
            </audio>
          )}
          {result.type === "video" &&
            result.frames &&
            result.frames.length > 0 && (
              <VideoSlideshow frames={result.frames} />
            )}
          {result.type === "video" && result.url && !result.frames && (
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
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="flex items-center text-3xl font-bold">
              <Sparkles className="mr-3 h-8 w-8 text-primary" />
              Media AI
            </h1>
            <p className="mt-2 text-muted-foreground">
              Generate text, images, audio, and video with the bundled OmniGen
              backend.
            </p>
          </div>
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
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wrench className="h-5 w-5" />
              OmniGen Setup
            </CardTitle>
            <CardDescription>
              Install the local Python runtime packages, download model groups,
              and control the bundled FastAPI server.
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
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => void refreshStatus()}
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
                Install Backend Dependencies
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

            <Separator />

            <div className="grid gap-3 md:grid-cols-2">
              {status?.models.map((model) => (
                <div
                  key={model.id}
                  className="flex items-center justify-between gap-3 rounded-lg border p-3"
                >
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      {model.downloaded && (
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                      )}
                      {model.label}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {MODEL_SIZE_HINTS[model.id]}
                    </div>
                  </div>
                  <Button
                    variant={model.downloaded ? "outline" : "secondary"}
                    size="sm"
                    onClick={() => void downloadModels([model.id])}
                    disabled={setupAction !== null || !status.venvExists}
                  >
                    {setupAction === `download:${model.id}` ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="mr-2 h-4 w-4" />
                    )}
                    {model.downloaded ? "Update" : "Download"}
                  </Button>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => void downloadModels(["text", "image", "audio"])}
                disabled={setupAction !== null || !status?.venvExists}
              >
                Download Core Models
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void downloadModels(["text", "image", "audio", "video"])
                }
                disabled={setupAction !== null || !status?.venvExists}
              >
                Download All Models
              </Button>
            </div>

            {status?.lastLog && (
              <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-3 text-xs">
                {status.lastLog}
              </pre>
            )}
          </CardContent>
        </Card>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as GenerationType)}
        >
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="text" className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              <span className="hidden sm:inline">Text</span>
            </TabsTrigger>
            <TabsTrigger value="image" className="flex items-center gap-2">
              <Image className="h-4 w-4" />
              <span className="hidden sm:inline">Image</span>
            </TabsTrigger>
            <TabsTrigger value="audio" className="flex items-center gap-2">
              <Music className="h-4 w-4" />
              <span className="hidden sm:inline">Audio</span>
            </TabsTrigger>
            <TabsTrigger value="video" className="flex items-center gap-2">
              <Video className="h-4 w-4" />
              <span className="hidden sm:inline">Video</span>
            </TabsTrigger>
          </TabsList>

          <GenerationTab
            value="text"
            title="Text Generation"
            description="Generate text with the local Phi-3 GGUF model."
            prompt={prompt}
            setPrompt={setPrompt}
            onGenerate={handleGenerate}
            disabled={isGenerating || !prompt.trim() || !isBackendOnline}
            loading={isGenerating && activeTab === "text"}
            icon={<Send className="mr-2 h-4 w-4" />}
            placeholder="Enter your text prompt..."
            buttonText="Generate Text"
          />
          <GenerationTab
            value="image"
            title="Image Generation"
            description="Generate images with the local Stable Diffusion ONNX model."
            prompt={prompt}
            setPrompt={setPrompt}
            onGenerate={handleGenerate}
            disabled={isGenerating || !prompt.trim() || !isBackendOnline}
            loading={isGenerating && activeTab === "image"}
            icon={<Image className="mr-2 h-4 w-4" />}
            placeholder="Describe the image you want..."
            buttonText="Generate Image"
          />
          <GenerationTab
            value="audio"
            title="Audio Generation"
            description="Generate speech with local SpeechT5 and HiFi-GAN models."
            prompt={prompt}
            setPrompt={setPrompt}
            onGenerate={handleGenerate}
            disabled={isGenerating || !prompt.trim() || !isBackendOnline}
            loading={isGenerating && activeTab === "audio"}
            icon={<Music className="mr-2 h-4 w-4" />}
            placeholder="Enter the text to speak..."
            buttonText="Generate Audio"
          />
          <GenerationTab
            value="video"
            title="Video Generation"
            description="Generate short CPU test videos at constrained resolution."
            prompt={prompt}
            setPrompt={setPrompt}
            onGenerate={handleGenerate}
            disabled={isGenerating || !prompt.trim() || !isBackendOnline}
            loading={isGenerating && activeTab === "video"}
            icon={<Video className="mr-2 h-4 w-4" />}
            placeholder="Describe a simple short scene..."
            buttonText="Generate Video"
          />
        </Tabs>

        {renderResult()}
      </div>
    </div>
  );
}

function StatusRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/20 p-3">
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-sm">{value || "Unavailable"}</div>
    </div>
  );
}

function GenerationTab({
  value,
  title,
  description,
  prompt,
  setPrompt,
  onGenerate,
  disabled,
  loading,
  icon,
  placeholder,
  buttonText,
}: {
  value: GenerationType;
  title: string;
  description: string;
  prompt: string;
  setPrompt: (value: string) => void;
  onGenerate: () => void;
  disabled: boolean;
  loading: boolean;
  icon: React.ReactNode;
  placeholder: string;
  buttonText: string;
}) {
  return (
    <TabsContent value={value} className="mt-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`${value}-prompt`}>Prompt</Label>
              <Textarea
                id={`${value}-prompt`}
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
                icon
              )}
              {loading ? "Generating..." : buttonText}
            </Button>
          </div>
        </CardContent>
      </Card>
    </TabsContent>
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

  // Fetch every frame as a blob (same trick as LoadingImage). Cleans up old
  // blob URLs on unmount or frames change.
  useEffect(() => {
    const controllers = frames.map(() => new AbortController());
    const localBlobs: (string | null)[] = frames.map(() => null);
    setBlobs([...localBlobs]);
    setErrorCount(0);

    frames.forEach((url, i) => {
      fetch(url, { signal: controllers[i].signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const blob = await r.blob();
          const blobUrl = URL.createObjectURL(blob);
          localBlobs[i] = blobUrl;
          setBlobs((prev) => {
            const next = [...prev];
            next[i] = blobUrl;
            return next;
          });
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          setErrorCount((n) => n + 1);
        });
    });

    return () => {
      controllers.forEach((c) => c.abort());
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
// useBlobImage — fetches a remote image as bytes and exposes a local blob URL.
// Cross-origin <img src=https://...> is unreliable in the Electron renderer
// for Pollinations.ai (slow first-byte time triggers onError, and some
// referrer/origin combos get rejected). Going through fetch + blob bypasses
// both issues: the byte stream completes once and is then served from the
// same-origin blob: URL, which <img> loads reliably.
// -----------------------------------------------------------------------------

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

    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(src, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setBlobUrl(createdUrl);
        setStatus("loaded");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
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
