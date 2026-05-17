import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  Image,
  Music,
  Video,
  MessageSquare,
  Send,
  Loader2,
  Download,
  Server,
  ServerOff,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";

// Media AI Backend Configuration
// Use 127.0.0.1 instead of localhost to force IPv4 — on Windows, `localhost`
// often resolves to IPv6 (::1) first, and if a different process is bound to
// the IPv6 loopback on :8000 the health check hits the wrong server and the
// backend appears "offline" even when it's running.
const MEDIA_AI_BACKEND_URL = "http://127.0.0.1:8000";
const BACKEND_SETUP_COMMANDS = `cd mediaai-backend/backend
pip install -r requirements.txt
$env:PYTHONPATH = "c:\\own_ai\\OrianBuilder\\mediaai-backend\\backend"
python -m uvicorn app.main:app --reload --port 8000`;

type GenerationType = "text" | "image" | "audio" | "video";

interface GenerationResult {
  type: GenerationType;
  content?: string;
  url?: string;
  // When set, the renderer uses this URL directly (no server prefix). Used by
  // cloud image/video sources like Pollinations.ai.
  absoluteUrl?: string;
  // Video-as-slideshow frames (cloud video). Renderer cycles these to simulate
  // motion when a true text-to-video model isn't available.
  frames?: string[];
  filename?: string;
  source?: "cloud" | "local";
}

// Pollinations.ai — free public text-to-image service. No auth, no key, no
// rate limit, returns image/jpeg directly. We pass nologo=true so the output
// isn't watermarked, and add a random seed for variety.
const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt";

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
  });
  return `${POLLINATIONS_BASE}/${encodeURIComponent(prompt)}?${params}`;
}

export default function MediaAIPage() {
  const [activeTab, setActiveTab] = useState<GenerationType>("text");
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [backendStatus, setBackendStatus] = useState<
    "checking" | "online" | "offline"
  >("checking");
  const [serverUrl, setServerUrl] = useState(MEDIA_AI_BACKEND_URL);
  const [showSettings, setShowSettings] = useState(false);

  // Check backend health
  const checkBackendHealth = async () => {
    try {
      const response = await fetch(`${serverUrl}/health`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      if (response.ok) {
        setBackendStatus("online");
      } else {
        setBackendStatus("offline");
      }
    } catch {
      setBackendStatus("offline");
    }
  };

  // Check health on mount and when server URL changes
  useState(() => {
    checkBackendHealth();
    const interval = setInterval(checkBackendHealth, 30000);
    return () => clearInterval(interval);
  });

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      toast.error("Please enter a prompt");
      return;
    }

    setIsGenerating(true);
    setResult(null);

    // Image & Video: bypass the broken Python pipeline and use Pollinations.ai
    // directly. Works without any backend, no auth, free.
    if (activeTab === "image") {
      try {
        const url = pollinationsUrl(prompt.trim(), {
          width: 768,
          height: 768,
        });
        // Pre-load to confirm Pollinations is reachable and the image renders
        await new Promise<void>((resolve, reject) => {
          const probe = new window.Image();
          probe.onload = () => resolve();
          probe.onerror = () =>
            reject(new Error("Pollinations.ai unreachable"));
          probe.src = url;
        });
        setResult({
          type: "image",
          absoluteUrl: url,
          filename: `image-${Date.now()}.jpg`,
          source: "cloud",
        });
        toast.success("Image generated!");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Image generation failed: ${msg}`);
      } finally {
        setIsGenerating(false);
      }
      return;
    }

    if (activeTab === "video") {
      try {
        // Generate 6 keyframes with sequential seeds so the same subject
        // appears across frames with small variation. Rendered as a cycling
        // slideshow for a motion-sequence effect.
        const baseSeed = Math.floor(Math.random() * 1_000_000);
        const frameCount = 6;
        const frames: string[] = [];
        for (let i = 0; i < frameCount; i++) {
          frames.push(
            pollinationsUrl(prompt.trim(), {
              width: 640,
              height: 360,
              seed: baseSeed + i,
            }),
          );
        }
        // Pre-load the first 2 frames so playback starts smoothly
        await Promise.all(
          frames.slice(0, 2).map(
            (u) =>
              new Promise<void>((resolve, reject) => {
                const probe = new window.Image();
                probe.onload = () => resolve();
                probe.onerror = () =>
                  reject(new Error("Pollinations.ai unreachable"));
                probe.src = u;
              }),
          ),
        );
        setResult({
          type: "video",
          frames,
          filename: `video-${Date.now()}.gif`,
          source: "cloud",
        });
        toast.success("Motion sequence generated! Remaining frames loading…");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Video generation failed: ${msg}`);
      } finally {
        setIsGenerating(false);
      }
      return;
    }

    // Text & Audio still use the local backend
    if (backendStatus !== "online") {
      toast.error(
        "Media AI backend is offline. Please start the backend server.",
      );
      setIsGenerating(false);
      return;
    }

    try {
      const endpoint = `/generate/${activeTab}`;
      const response = await fetch(`${serverUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });

      if (!response.ok) {
        const errorData = await response
          .json()
          .catch(() => ({ detail: `HTTP error! status: ${response.status}` }));
        throw new Error(
          errorData.detail || `HTTP error! status: ${response.status}`,
        );
      }

      const data = await response.json();

      setResult({
        type: activeTab,
        content: data.text || data.response,
        url: data.image_url || data.audio_url || data.video_url,
        filename: data.filename,
        source: "local",
      });

      toast.success(
        `${activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} generated successfully!`,
      );
    } catch (error) {
      console.error("Generation error:", error);
      const errorMsg = error instanceof Error ? error.message : "Unknown error";

      const isOnnxError =
        /OMNIGEN_IMAGE_EXPORT_ONNX|Python 3\.14|Optimum ONNX export|onnx.*Invalid argument|nmkd\/stable-diffusion-1\.5-onnx|stable-diffusion-1\.5-onnx/i.test(
          errorMsg,
        );
      const isErrno22 = /\[Errno 22\]|Invalid argument/i.test(errorMsg);
      const isMemory = /out of memory|MemoryError/i.test(errorMsg);

      if (isOnnxError || isErrno22) {
        toast.error(
          `${activeTab} model can't load. See the help panel below for fix steps.`,
          { duration: 10000 },
        );
        setResult({
          type: activeTab,
          content:
            `Couldn't load the ${activeTab} model on this backend setup.\n\n` +
            `WHY: Either the ONNX runtime can't load on Python 3.14, or the\n` +
            `HuggingFace cache path is too long / has Windows symlink issues.\n\n` +
            `FIX OPTIONS — try in order:\n\n` +
            `1) Use a short HuggingFace cache dir (one-line fix):\n` +
            `   [Environment]::SetEnvironmentVariable("HF_HOME","C:\\hf",[EnvironmentVariableTarget]::User)\n` +
            `   # then restart the backend\n\n` +
            `2) Enable Windows Developer Mode (allows symlinks):\n` +
            `   Settings → Privacy & Security → For developers → Developer Mode = On\n\n` +
            `3) Re-create the backend venv on Python 3.12:\n` +
            `   py -3.12 -m venv mediaai-backend\\backend\\.venv\n` +
            `   .\\mediaai-backend\\backend\\.venv\\Scripts\\Activate.ps1\n` +
            `   pip install -r mediaai-backend\\backend\\requirements.txt\n\n` +
            `4) Disable ONNX export (if set):\n` +
            `   Remove-Item Env:OMNIGEN_IMAGE_EXPORT_ONNX\n\n` +
            `After any fix, restart the backend and try again.\n\n` +
            `Original error: ${errorMsg}`,
        });
      } else if (isMemory) {
        toast.error(
          `${activeTab} generation ran out of memory. Try a smaller model or close other apps.`,
          { duration: 8000 },
        );
        setResult({
          type: activeTab,
          content:
            `Out of memory while generating ${activeTab}.\n\n` +
            `Try: close other apps, use a smaller prompt, or switch to a quantised model.\n\n` +
            `Original error: ${errorMsg}`,
        });
      } else {
        toast.error(`Failed to generate ${activeTab}: ${errorMsg}`);
      }
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
      // Video slideshow: download the first frame as a representative image.
      // (Browser can't build a real MP4 from URLs without ffmpeg.wasm.)
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
              Generated{" "}
              {result.type.charAt(0).toUpperCase() + result.type.slice(1)}
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
            <div className="prose max-w-none">
              <p className="whitespace-pre-wrap">{result.content}</p>
            </div>
          )}
          {result.type === "image" && imageSrc && (
            <div className="flex justify-center">
              <img
                src={imageSrc}
                alt="Generated"
                className="max-w-full rounded-lg shadow-lg"
                style={{ maxHeight: "512px" }}
              />
            </div>
          )}
          {result.type === "audio" && result.url && (
            <div className="flex flex-col items-center gap-4">
              <audio controls className="w-full max-w-md">
                <source src={`${serverUrl}${result.url}`} type="audio/wav" />
                Your browser does not support the audio element.
              </audio>
            </div>
          )}
          {result.type === "video" &&
            result.frames &&
            result.frames.length > 0 && (
              <VideoSlideshow frames={result.frames} />
            )}
          {result.type === "video" && result.url && !result.frames && (
            <div className="flex justify-center">
              <video
                controls
                className="max-w-full rounded-lg shadow-lg"
                style={{ maxHeight: "400px" }}
              >
                <source src={`${serverUrl}${result.url}`} type="video/mp4" />
                Your browser does not support the video element.
              </video>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="w-full px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="flex items-center text-3xl font-bold">
              <Sparkles className="mr-3 h-8 w-8 text-primary" />
              Media AI
            </h1>
            <p className="mt-2 text-muted-foreground">
              Generate text, images, audio, and video using local AI models
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Backend Status */}
            <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
              {backendStatus === "online" ? (
                <>
                  <Server className="h-4 w-4 text-green-500" />
                  <span className="text-sm text-green-600">Backend Online</span>
                </>
              ) : backendStatus === "offline" ? (
                <>
                  <ServerOff className="h-4 w-4 text-red-500" />
                  <span className="text-sm text-red-600">Backend Offline</span>
                </>
              ) : (
                <>
                  <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />
                  <span className="text-sm text-yellow-600">Checking...</span>
                </>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowSettings(!showSettings)}
              className={showSettings ? "bg-accent" : ""}
            >
              <Settings className="h-5 w-5" />
            </Button>
          </div>
        </div>

        {/* Settings Panel */}
        {showSettings && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Backend Settings</CardTitle>
              <CardDescription>
                Configure the Media AI backend server URL
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Input
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8000"
                  className="flex-1"
                />
                <Button onClick={checkBackendHealth} variant="secondary">
                  Test Connection
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Default: http://127.0.0.1:8000. Make sure the OmniGen backend is
                running. Use 127.0.0.1 instead of localhost to avoid IPv6
                resolution issues on Windows.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Generation Tabs */}
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

          <TabsContent value="text" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Text Generation</CardTitle>
                <CardDescription>
                  Generate text using local Phi-3 model
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="text-prompt">Prompt</Label>
                    <Textarea
                      id="text-prompt"
                      placeholder="Enter your text prompt here..."
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      rows={4}
                    />
                  </div>
                  <Button
                    onClick={handleGenerate}
                    disabled={isGenerating || !prompt.trim()}
                    className="w-full"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Send className="mr-2 h-4 w-4" />
                        Generate Text
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="image" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Image Generation</CardTitle>
                <CardDescription>
                  Generate images via Pollinations.ai (Flux model, cloud, free —
                  no backend setup needed)
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="image-prompt">Image Prompt</Label>
                    <Textarea
                      id="image-prompt"
                      placeholder="Describe the image you want to generate..."
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      rows={4}
                    />
                  </div>
                  <Button
                    onClick={handleGenerate}
                    disabled={isGenerating || !prompt.trim()}
                    className="w-full"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Image className="mr-2 h-4 w-4" />
                        Generate Image
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="audio" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Audio Generation</CardTitle>
                <CardDescription>
                  Generate speech/audio using SpeechT5 (local)
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="audio-prompt">Text to Speak</Label>
                    <Textarea
                      id="audio-prompt"
                      placeholder="Enter the text you want to convert to speech..."
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      rows={4}
                    />
                  </div>
                  <Button
                    onClick={handleGenerate}
                    disabled={isGenerating || !prompt.trim()}
                    className="w-full"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Music className="mr-2 h-4 w-4" />
                        Generate Audio
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="video" className="mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Video Generation</CardTitle>
                <CardDescription>
                  Generate a 6-frame motion sequence from your prompt — runs in
                  the cloud, no backend setup required
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="rounded-lg bg-sky-50 p-3 text-sm text-sky-800 dark:bg-sky-950/30 dark:text-sky-200">
                    <strong>Cloud mode:</strong> Generates 6 keyframes at
                    640×360 via Pollinations.ai and plays them as an animated
                    slideshow. Free, no auth, ~10 seconds total.
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="video-prompt">Video Description</Label>
                    <Textarea
                      id="video-prompt"
                      placeholder="Describe a simple scene (e.g., 'candle flame flickering', 'water flowing')..."
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      rows={4}
                    />
                  </div>
                  <Button
                    onClick={handleGenerate}
                    disabled={isGenerating || !prompt.trim()}
                    className="w-full"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Generating (may take 2-5 minutes)...
                      </>
                    ) : (
                      <>
                        <Video className="mr-2 h-4 w-4" />
                        Generate Test Video
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Results Section */}
        {renderResult()}

        {/* Instructions */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>Getting Started</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4 text-sm text-muted-foreground">
              <p>
                <strong>1. Start the Backend Server:</strong>
              </p>
              <pre className="w-full max-w-full overflow-x-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                {BACKEND_SETUP_COMMANDS}
              </pre>
              <Separator />
              <p>
                <strong>2. Available Models:</strong>
              </p>
              <ul className="ml-4 list-disc space-y-1">
                <li>Text: Phi-3-mini-4k-instruct (GGUF)</li>
                <li>Image: Stable Diffusion 1.5 (ONNX)</li>
                <li>Audio: SpeechT5 TTS + HiFi-GAN</li>
                <li>
                  Video: Text-to-Video MS-1.7B (8 frames, 256x256, low quality
                  for testing)
                </li>
              </ul>
              <Separator />
              <p>
                <strong>Note:</strong> First generation may take longer as
                models are downloaded. Video generation requires ~5GB model
                download and 8GB+ RAM.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// VideoSlideshow — renders a list of frame URLs as an auto-cycling slideshow.
// Used as a stand-in for true text-to-video when running the cloud generator,
// which only produces still images. Frames cross-fade for a smooth feel and
// the user can play/pause and scrub.
// -----------------------------------------------------------------------------

function VideoSlideshow({ frames }: { frames: string[] }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [loaded, setLoaded] = useState<Set<number>>(new Set());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const FRAME_MS = 700;

  useEffect(() => {
    if (!playing) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => {
      setIndex((i) => (i + 1) % frames.length);
    }, FRAME_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, frames.length]);

  // Pre-load all frames so the cycle is smooth
  useEffect(() => {
    frames.forEach((url, i) => {
      const probe = new window.Image();
      probe.onload = () => {
        setLoaded((prev) => {
          if (prev.has(i)) return prev;
          const next = new Set(prev);
          next.add(i);
          return next;
        });
      };
      probe.src = url;
    });
  }, [frames]);

  const allLoaded = loaded.size === frames.length;

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="relative w-full max-w-2xl overflow-hidden rounded-lg bg-black shadow-lg"
        style={{ aspectRatio: "16 / 9" }}
      >
        {frames.map((url, i) => (
          <img
            key={i}
            src={url}
            alt={`Frame ${i + 1}`}
            className="absolute inset-0 h-full w-full object-cover transition-opacity duration-300"
            style={{ opacity: i === index ? 1 : 0 }}
          />
        ))}
        {/* Loading shimmer until at least 2 frames are ready */}
        {loaded.size < 2 && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm text-white">
            Loading frames… ({loaded.size}/{frames.length})
          </div>
        )}
        {/* Frame indicator dots */}
        <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1.5">
          {frames.map((_, i) => (
            <button
              key={i}
              onClick={() => {
                setIndex(i);
                setPlaying(false);
              }}
              className={`h-1.5 rounded-full transition-all ${
                i === index ? "w-6 bg-white" : "w-1.5 bg-white/50"
              }`}
              aria-label={`Frame ${i + 1}`}
            />
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <button
          onClick={() => setPlaying((p) => !p)}
          className="rounded-full border px-3 py-1 hover:bg-accent"
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <span>
          Frame {index + 1} / {frames.length}
          {!allLoaded && ` · ${loaded.size}/${frames.length} loaded`}
        </span>
      </div>
    </div>
  );
}
