import { useState, useRef } from "react";
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
  Square,
  Search,
  Play,
  Pause,
  Download,
} from "lucide-react";
import { OrianBuilderAppMediaFolder } from "@/components/OrianBuilderAppMediaFolder";
import { LibrarySearchBar } from "@/components/LibrarySearchBar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppSearchSelect } from "@/components/AppSearchSelect";
import { filterMediaAppsByQuery } from "@/lib/mediaUtils";
import { ipc } from "@/ipc/types";
import type { ImageThemeMode } from "@/ipc/types";
import { cn } from "@/lib/utils";

type GenerateTab = "image" | "video" | "audio" | "music";

interface ItunesTrack {
  trackId: number;
  trackName: string;
  artistName: string;
  collectionName: string;
  artworkUrl100: string;
  previewUrl: string;
  primaryGenreName: string;
  trackTimeMillis?: number;
}

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
  const vidCancelRef = useRef(false);

  // Audio state
  const [audPrompt, setAudPrompt] = useState("");
  const [audAppId, setAudAppId] = useState<number | null>(null);
  const [audStatus, setAudStatus] = useState<
    "idle" | "generating" | "done" | "error"
  >("idle");
  const [audError, setAudError] = useState("");
  const [audResult, setAudResult] = useState<string | null>(null);
  const audCancelRef = useRef(false);

  // Music search state
  const [musicQuery, setMusicQuery] = useState("");
  const [musicResults, setMusicResults] = useState<ItunesTrack[]>([]);
  const [musicSearching, setMusicSearching] = useState(false);
  const [musicSearchError, setMusicSearchError] = useState("");
  const [playingTrackId, setPlayingTrackId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const filteredMediaApps = filterMediaAppsByQuery(mediaApps, searchQuery);
  const effectiveImgAppId =
    imgAppId ?? (allApps.length === 1 ? allApps[0].id : null);
  const effectiveVidAppId =
    vidAppId ?? (allApps.length === 1 ? allApps[0].id : null);
  const effectiveAudAppId =
    audAppId ?? (allApps.length === 1 ? allApps[0].id : null);

  const handleTabChange = (tab: GenerateTab) => {
    // Stop any playing music when leaving the music tab
    if (activeTab === "music") {
      audioRef.current?.pause();
      setPlayingTrackId(null);
    }
    setActiveTab(tab);
  };

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

  const handleStopVideo = () => {
    vidCancelRef.current = true;
    setVidStatus("idle");
    setVidError("");
  };

  const handleGenerateVideo = async () => {
    if (!vidPrompt.trim() || effectiveVidAppId === null) return;
    vidCancelRef.current = false;
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
      if (vidCancelRef.current) return;
      if (result.success) {
        setVidStatus("done");
        setVidResult(result.fileName ?? null);
        setVidPrompt("");
      } else {
        setVidStatus("error");
        setVidError(result.error ?? "Video generation failed");
      }
    } catch (err) {
      if (vidCancelRef.current) return;
      setVidStatus("error");
      setVidError(
        err instanceof Error ? err.message : "Video generation failed",
      );
    }
  };

  const handleStopAudio = () => {
    audCancelRef.current = true;
    setAudStatus("idle");
    setAudError("");
  };

  const handleGenerateAudio = async () => {
    if (!audPrompt.trim() || effectiveAudAppId === null) return;
    audCancelRef.current = false;
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
      if (audCancelRef.current) return;
      if (result.success) {
        setAudStatus("done");
        setAudResult(result.fileName ?? null);
        setAudPrompt("");
      } else {
        setAudStatus("error");
        setAudError(result.error ?? "Audio generation failed");
      }
    } catch (err) {
      if (audCancelRef.current) return;
      setAudStatus("error");
      setAudError(
        err instanceof Error ? err.message : "Audio generation failed",
      );
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
    // Open the preview URL in the default browser so the user can save the file
    await ipc.system.openExternalUrl(track.previewUrl);
  };

  const artworkUrl = (url: string) => url.replace("100x100bb", "300x300bb");

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
            {(["image", "video", "audio", "music"] as GenerateTab[]).map(
              (tab) => {
                const Icon =
                  tab === "image"
                    ? Image
                    : tab === "video"
                      ? Video
                      : tab === "audio"
                        ? Music
                        : Search;
                return (
                  <button
                    key={tab}
                    onClick={() => handleTabChange(tab)}
                    className={cn(
                      "flex items-center gap-1.5 px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px",
                      activeTab === tab
                        ? "border-primary text-primary"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {tab === "music" ? "Music Search" : tab}
                  </button>
                );
              },
            )}
          </div>

          {/* Tab content — single position in tree with key forces clean remount
              on tab switch, preventing React from reusing textarea DOM nodes */}
          {activeTab === "image" ? (
            <div key="image" className="space-y-4 max-w-2xl">
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
              <div className="flex gap-2">
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
                {generateImage.isPending && (
                  <Button
                    variant="outline"
                    onClick={() => generateImage.reset()}
                  >
                    <Square className="mr-2 h-4 w-4" />
                    Stop
                  </Button>
                )}
              </div>
            </div>
          ) : activeTab === "video" ? (
            <div key="video" className="space-y-4 max-w-2xl">
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
              <div className="flex gap-2">
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
                {vidStatus === "generating" && (
                  <Button variant="outline" onClick={handleStopVideo}>
                    <Square className="mr-2 h-4 w-4" />
                    Stop
                  </Button>
                )}
              </div>
            </div>
          ) : activeTab === "audio" ? (
            <div key="audio" className="space-y-4 max-w-2xl">
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
              <div className="flex gap-2">
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
                {audStatus === "generating" && (
                  <Button variant="outline" onClick={handleStopAudio}>
                    <Square className="mr-2 h-4 w-4" />
                    Stop
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div key="music" className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Search for songs and ringtones. Preview 30-second clips and
                download them to use in your apps.
              </p>
              {/* Search bar */}
              <div className="flex gap-2 max-w-xl">
                <Input
                  placeholder="Search songs, artists, or ringtones..."
                  value={musicQuery}
                  onChange={(e) => setMusicQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleMusicSearch();
                  }}
                  className="flex-1"
                />
                <Button
                  onClick={handleMusicSearch}
                  disabled={!musicQuery.trim() || musicSearching}
                >
                  {musicSearching ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )}
                  <span className="ml-2">
                    {musicSearching ? "Searching..." : "Search"}
                  </span>
                </Button>
              </div>

              {/* Error */}
              {musicSearchError && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <AlertCircle className="h-4 w-4" />
                  {musicSearchError}
                </div>
              )}

              {/* Results grid */}
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
                        src={artworkUrl(track.artworkUrl100)}
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
                          onClick={() => handleDownloadTrack(track)}
                          title="Download preview"
                        >
                          <Download className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
