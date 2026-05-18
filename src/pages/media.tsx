import { useState } from "react";
import { useAppMediaFiles } from "@/hooks/useAppMediaFiles";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useGenerateImage } from "@/hooks/useGenerateImage";
import {
  Image,
  Video,
  Music,
  Loader2,
  Sparkles,
  Box,
  Camera,
  Layers,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { OrianBuilderAppMediaFolder } from "@/components/OrianBuilderAppMediaFolder";
import { LibrarySearchBar } from "@/components/LibrarySearchBar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { AppSearchSelect } from "@/components/AppSearchSelect";
import { filterMediaAppsByQuery } from "@/lib/mediaUtils";
import { ipc } from "@/ipc/types";
import type { ImageThemeMode } from "@/ipc/types";
import { cn } from "@/lib/utils";

type GenerateTab = "image" | "video" | "audio";

const IMAGE_STYLES: {
  value: ImageThemeMode;
  label: string;
  icon: typeof Sparkles;
}[] = [
  { value: "plain", label: "Plain", icon: Sparkles },
  { value: "3d-clay", label: "3D/Clay", icon: Box },
  { value: "real-photography", label: "Photo", icon: Camera },
  { value: "isometric-illustration", label: "Isometric", icon: Layers },
];

export default function MediaPage() {
  const {
    mediaApps,
    isLoading,
    renameMediaFile,
    deleteMediaFile,
    moveMediaFile,
    isMutatingMedia,
  } = useAppMediaFiles();
  const { apps: allApps } = useLoadApps();
  const generateImage = useGenerateImage();

  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<GenerateTab>("image");

  // Image state
  const [imgPrompt, setImgPrompt] = useState("");
  const [imgStyle, setImgStyle] = useState<ImageThemeMode>("plain");
  const [imgAppId, setImgAppId] = useState<number | null>(null);

  // Video state
  const [vidPrompt, setVidPrompt] = useState("");
  const [vidAppId, setVidAppId] = useState<number | null>(null);
  const [vidStatus, setVidStatus] = useState<
    "idle" | "generating" | "done" | "error"
  >("idle");
  const [vidError, setVidError] = useState("");
  const [vidResult, setVidResult] = useState<string | null>(null);

  // Audio state
  const [audPrompt, setAudPrompt] = useState("");
  const [audAppId, setAudAppId] = useState<number | null>(null);
  const [audStatus, setAudStatus] = useState<
    "idle" | "generating" | "done" | "error"
  >("idle");
  const [audError, setAudError] = useState("");
  const [audResult, setAudResult] = useState<string | null>(null);

  const filteredMediaApps = filterMediaAppsByQuery(mediaApps, searchQuery);
  const effectiveImgAppId =
    imgAppId ?? (allApps.length === 1 ? allApps[0].id : null);
  const effectiveVidAppId =
    vidAppId ?? (allApps.length === 1 ? allApps[0].id : null);
  const effectiveAudAppId =
    audAppId ?? (allApps.length === 1 ? allApps[0].id : null);

  const handleGenerateImage = () => {
    if (!imgPrompt.trim() || effectiveImgAppId === null) return;
    const targetApp = allApps.find((a) => a.id === effectiveImgAppId);
    if (!targetApp) return;
    generateImage.mutate({
      requestId: crypto.randomUUID(),
      prompt: imgPrompt.trim(),
      themeMode: imgStyle,
      targetAppId: effectiveImgAppId,
      targetAppName: targetApp.name,
      source: "media-library",
    });
    setImgPrompt("");
  };

  const handleGenerateVideo = async () => {
    if (!vidPrompt.trim() || effectiveVidAppId === null) return;
    setVidStatus("generating");
    setVidError("");
    setVidResult(null);
    try {
      const result = await ipc.misc.generateMediaForApp({
        appId: effectiveVidAppId,
        modelType: "video",
        prompt: vidPrompt.trim(),
        requestId: crypto.randomUUID(),
      });
      if (result.success) {
        setVidStatus("done");
        setVidResult(result.fileName ?? null);
        setVidPrompt("");
      } else {
        setVidStatus("error");
        setVidError(result.error ?? "Video generation failed");
      }
    } catch (err) {
      setVidStatus("error");
      setVidError(
        err instanceof Error ? err.message : "Video generation failed",
      );
    }
  };

  const handleGenerateAudio = async () => {
    if (!audPrompt.trim() || effectiveAudAppId === null) return;
    setAudStatus("generating");
    setAudError("");
    setAudResult(null);
    try {
      const result = await ipc.misc.generateMediaForApp({
        appId: effectiveAudAppId,
        modelType: "audio",
        prompt: audPrompt.trim(),
        requestId: crypto.randomUUID(),
      });
      if (result.success) {
        setAudStatus("done");
        setAudResult(result.fileName ?? null);
        setAudPrompt("");
      } else {
        setAudStatus("error");
        setAudError(result.error ?? "Audio generation failed");
      }
    } catch (err) {
      setAudStatus("error");
      setAudError(
        err instanceof Error ? err.message : "Audio generation failed",
      );
    }
  };

  return (
    <div className="w-full px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-8">
        {/* AI Generation Section */}
        <div>
          <h1 className="flex items-center text-2xl font-bold sm:text-3xl page-title mb-4">
            <Sparkles className="mr-2 h-7 w-7 sm:h-8 sm:w-8" />
            Media AI
          </h1>

          {/* Tabs */}
          <div className="flex gap-1 mb-4 border-b border-border">
            {(["image", "video", "audio"] as GenerateTab[]).map((tab) => {
              const Icon =
                tab === "image" ? Image : tab === "video" ? Video : Music;
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    "flex items-center gap-1.5 px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px",
                    activeTab === tab
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {tab}
                </button>
              );
            })}
          </div>

          {/* Image Tab */}
          {activeTab === "image" && (
            <div className="space-y-4 max-w-2xl">
              <div className="space-y-2">
                <Label>Prompt</Label>
                <Textarea
                  placeholder="Describe the image you want to create..."
                  value={imgPrompt}
                  onChange={(e) => setImgPrompt(e.target.value)}
                  className="min-h-[80px] resize-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                      handleGenerateImage();
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label>Style</Label>
                <div className="flex gap-2 flex-wrap">
                  {IMAGE_STYLES.map((s) => {
                    const Icon = s.icon;
                    return (
                      <button
                        key={s.value}
                        onClick={() => setImgStyle(s.value)}
                        className={cn(
                          "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors",
                          imgStyle === s.value
                            ? "border-primary bg-primary/5 text-primary"
                            : "border-border hover:border-primary/30 text-muted-foreground",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {s.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <Label>Save to App</Label>
                <AppSearchSelect
                  apps={allApps}
                  selectedAppId={effectiveImgAppId}
                  onSelect={setImgAppId}
                />
              </div>
              <Button
                onClick={handleGenerateImage}
                disabled={
                  !imgPrompt.trim() ||
                  effectiveImgAppId === null ||
                  generateImage.isPending
                }
              >
                {generateImage.isPending ? (
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
          )}

          {/* Video Tab */}
          {activeTab === "video" && (
            <div className="space-y-4 max-w-2xl">
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
                <strong>Requires local AI server.</strong> Video generation uses
                a local Python backend. If not running, generation will fail
                with a clear error.
              </div>
              <div className="space-y-2">
                <Label>Prompt</Label>
                <Textarea
                  placeholder="Describe the video you want to create..."
                  value={vidPrompt}
                  onChange={(e) => setVidPrompt(e.target.value)}
                  className="min-h-[80px] resize-none"
                />
              </div>
              <div className="space-y-2">
                <Label>Save to App</Label>
                <AppSearchSelect
                  apps={allApps}
                  selectedAppId={effectiveVidAppId}
                  onSelect={setVidAppId}
                />
              </div>
              {vidStatus === "error" && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{vidError}</span>
                </div>
              )}
              {vidStatus === "done" && vidResult && (
                <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4" />
                  Saved: {vidResult}
                </div>
              )}
              <Button
                onClick={handleGenerateVideo}
                disabled={
                  !vidPrompt.trim() ||
                  effectiveVidAppId === null ||
                  vidStatus === "generating"
                }
              >
                {vidStatus === "generating" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Generating video...
                  </>
                ) : (
                  <>
                    <Video className="mr-2 h-4 w-4" />
                    Generate Video
                  </>
                )}
              </Button>
            </div>
          )}

          {/* Audio Tab */}
          {activeTab === "audio" && (
            <div className="space-y-4 max-w-2xl">
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
                <strong>Requires local AI server.</strong> Audio/TTS generation
                uses a local Python backend. If not running, generation will
                fail with a clear error.
              </div>
              <div className="space-y-2">
                <Label>Text to speak / audio prompt</Label>
                <Textarea
                  placeholder="Enter text to convert to speech..."
                  value={audPrompt}
                  onChange={(e) => setAudPrompt(e.target.value)}
                  className="min-h-[80px] resize-none"
                />
              </div>
              <div className="space-y-2">
                <Label>Save to App</Label>
                <AppSearchSelect
                  apps={allApps}
                  selectedAppId={effectiveAudAppId}
                  onSelect={setAudAppId}
                />
              </div>
              {audStatus === "error" && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{audError}</span>
                </div>
              )}
              {audStatus === "done" && audResult && (
                <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4" />
                  Saved: {audResult}
                </div>
              )}
              <Button
                onClick={handleGenerateAudio}
                disabled={
                  !audPrompt.trim() ||
                  effectiveAudAppId === null ||
                  audStatus === "generating"
                }
              >
                {audStatus === "generating" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Generating audio...
                  </>
                ) : (
                  <>
                    <Music className="mr-2 h-4 w-4" />
                    Generate Audio
                  </>
                )}
              </Button>
            </div>
          )}
        </div>

        {/* Media Library Section */}
        <div>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-xl font-semibold">Media Library</h2>
          </div>

          <LibrarySearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search media files..."
          />

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredMediaApps.length === 0 ? (
            <div className="text-muted-foreground text-center py-12">
              {searchQuery
                ? "No results found."
                : "No media files yet. Generate some above or they'll appear here when created by your apps."}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
              {filteredMediaApps.map((app) => (
                <OrianBuilderAppMediaFolder
                  key={`media-${app.appId}`}
                  appId={app.appId}
                  appPath={app.appPath}
                  appName={app.appName}
                  files={app.files}
                  allApps={allApps}
                  onRenameMediaFile={renameMediaFile}
                  onDeleteMediaFile={deleteMediaFile}
                  onMoveMediaFile={moveMediaFile}
                  isMutatingMedia={isMutatingMedia}
                  searchQuery={searchQuery}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
