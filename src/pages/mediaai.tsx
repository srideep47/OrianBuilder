import { useState } from "react";
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
const MEDIA_AI_BACKEND_URL = "http://localhost:8000";

type GenerationType = "text" | "image" | "audio" | "video";

interface GenerationResult {
  type: GenerationType;
  content?: string;
  url?: string;
  filename?: string;
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

    if (backendStatus !== "online") {
      toast.error(
        "Media AI backend is offline. Please start the backend server.",
      );
      return;
    }

    setIsGenerating(true);
    setResult(null);

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
      });

      toast.success(
        `${activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} generated successfully!`,
      );
    } catch (error) {
      console.error("Generation error:", error);
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to generate ${activeTab}: ${errorMsg}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = () => {
    if (result?.url) {
      const link = document.createElement("a");
      link.href = `${serverUrl}${result.url}`;
      link.download = result.filename || `generated-${activeTab}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const renderResult = () => {
    if (!result) return null;

    return (
      <Card className="mt-6">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>
              Generated{" "}
              {result.type.charAt(0).toUpperCase() + result.type.slice(1)}
            </CardTitle>
            <CardDescription>
              Your AI-generated content is ready
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
          {result.type === "text" && result.content && (
            <div className="prose max-w-none">
              <p className="whitespace-pre-wrap">{result.content}</p>
            </div>
          )}
          {result.type === "image" && result.url && (
            <div className="flex justify-center">
              <img
                src={`${serverUrl}${result.url}`}
                alt="Generated"
                className="max-w-full rounded-lg shadow-lg"
                style={{ maxHeight: "400px" }}
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
          {result.type === "video" && result.url && (
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
                  placeholder="http://localhost:8000"
                  className="flex-1"
                />
                <Button onClick={checkBackendHealth} variant="secondary">
                  Test Connection
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Default: http://localhost:8000. Make sure the OmniGen backend is
                running.
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
                  Generate images using Stable Diffusion (local)
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
                  Generate short test videos using Text-to-Video model (low
                  quality for testing)
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="rounded-lg bg-yellow-50 dark:bg-yellow-950/30 p-3 text-sm text-yellow-800 dark:text-yellow-200">
                    <strong>⚠️ Test Mode:</strong> Generates 8 frames at 256x256
                    resolution (2 seconds @ 4fps). First run downloads ~5GB
                    model. Requires 8GB+ RAM.
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
              <pre className="rounded bg-muted p-3 text-xs">
                cd mediaai-backend/backend pip install -r requirements.txt
                $env:PYTHONPATH =
                "c:\own_ai\OrianBuilder\mediaai-backend\backend"; python -m
                uvicorn app.main:app --reload --port 8000
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
