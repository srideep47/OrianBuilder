import { useState, useMemo, useCallback } from "react";
import { useAppMediaFiles } from "@/hooks/useAppMediaFiles";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useGeneratedMedia } from "@/hooks/useGeneratedMedia";
import {
  Search,
  Sparkles,
  ImageIcon,
  Film,
  Music,
  Box,
  Loader2,
  Scissors,
  CheckSquare,
  Square,
  X,
} from "lucide-react";
import { OrianBuilderAppMediaFolder } from "@/components/OrianBuilderAppMediaFolder";
import { GeneratedMediaCard } from "@/components/GeneratedMediaCard";
import { LibrarySearchBar } from "@/components/LibrarySearchBar";
import { VideoEditDialog } from "@/components/VideoEditDialog";
import { Button } from "@/components/ui/button";
import { filterMediaAppsByQuery } from "@/lib/mediaUtils";
import { useNavigate } from "@tanstack/react-router";
import type { GeneratedMediaKind, GeneratedMediaItem } from "@/ipc/types";
import { ipc } from "@/ipc/types";
import { cn } from "@/lib/utils";
import { generatedMediaUrl } from "@/ipc/types";

const CATEGORIES: { kind: GeneratedMediaKind; label: string; icon: typeof ImageIcon }[] = [
  { kind: "image", label: "Images", icon: ImageIcon },
  { kind: "video", label: "Videos", icon: Film },
  { kind: "model", label: "3D Models", icon: Box },
  { kind: "audio", label: "Audio", icon: Music },
];

export default function MediaPage() {
  const navigate = useNavigate();
  const {
    mediaApps,
    isLoading: appMediaLoading,
    renameMediaFile,
    deleteMediaFile,
    moveMediaFile,
    isMutatingMedia,
  } = useAppMediaFiles();
  const { apps: allApps } = useLoadApps();
  const {
    items: generatedMedia,
    isLoading: generatedLoading,
    removeItem,
    isMutating,
  } = useGeneratedMedia();

  const [searchQuery, setSearchQuery] = useState("");

  // Video editing selection state — when non-empty the Videos section flips
  // into a checkbox grid and a floating action bar shows up.
  const [selecting, setSelecting] = useState(false);
  const [selectedVideos, setSelectedVideos] = useState<string[]>([]);
  const [editOpen, setEditOpen] = useState(false);

  const filteredMediaApps = useMemo(
    () => filterMediaAppsByQuery(mediaApps, searchQuery),
    [mediaApps, searchQuery],
  );

  const filteredGenerated = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return generatedMedia;
    return generatedMedia.filter(
      (m) =>
        (m.prompt?.toLowerCase().includes(q) ?? false) ||
        m.fileName.toLowerCase().includes(q),
    );
  }, [generatedMedia, searchQuery]);

  const byKind = useMemo(() => {
    const map: Record<GeneratedMediaKind, typeof filteredGenerated> = {
      image: [],
      video: [],
      audio: [],
      model: [],
    };
    for (const item of filteredGenerated) map[item.kind].push(item);
    return map;
  }, [filteredGenerated]);

  const toggleSelect = useCallback((fileName: string) => {
    setSelectedVideos((prev) =>
      prev.includes(fileName)
        ? prev.filter((f) => f !== fileName)
        : [...prev, fileName],
    );
  }, []);

  const enterSelection = () => {
    setSelecting(true);
    setSelectedVideos([]);
    // Pre-warm the Media AI backend — ffmpeg concat lives there and the user
    // will need it healthy by the time they hit Join. Fire-and-forget; the
    // IPC handler also auto-starts as a fallback.
    void ipc.mediaAi
      .getStatus(undefined)
      .then((s) => {
        if (!s.healthy) return ipc.mediaAi.startBackend(undefined);
      })
      .catch(() => undefined);
  };

  const exitSelection = () => {
    setSelecting(false);
    setSelectedVideos([]);
  };

  const selectedItems: GeneratedMediaItem[] = useMemo(
    () =>
      selectedVideos
        .map((fn) => byKind.video.find((v) => v.fileName === fn))
        .filter((v): v is GeneratedMediaItem => Boolean(v)),
    [selectedVideos, byKind.video],
  );

  const isLoading = appMediaLoading || generatedLoading;
  const isEmpty =
    filteredMediaApps.length === 0 && filteredGenerated.length === 0;

  return (
    <div className="flex h-full flex-col overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 pb-4 pt-6">
        <div className="flex items-center gap-2">
          <ImageIcon className="h-5 w-5 text-primary" />
          <h1 className="text-base font-semibold">Media</h1>
        </div>
        <Button size="sm" variant="outline" onClick={() => void navigate({ to: "/mediaai" })}>
          <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          Generate in Gen Assets
        </Button>
      </div>

      {/* Search */}
      <div className="px-6 pt-4">
        <LibrarySearchBar value={searchQuery} onChange={setSearchQuery} />
      </div>

      {/* Content */}
      <div className="flex-1 px-6 py-4 pb-24">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
            <Search className="h-10 w-10 text-muted-foreground/30" />
            <div>
              <p className="text-sm font-medium">No media yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Generate images, videos or 3D models in{" "}
                <button className="text-primary underline" onClick={() => void navigate({ to: "/mediaai" })}>
                  Gen Assets
                </button>{" "}
                — they appear here automatically.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            {/* Generated content, grouped by category */}
            {CATEGORIES.map(({ kind, label, icon: Icon }) => {
              const items = byKind[kind];
              if (items.length === 0) return null;

              const isVideoSection = kind === "video";
              return (
                <section key={kind}>
                  <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {label}
                    <span className="text-xs font-normal text-muted-foreground">
                      ({items.length})
                    </span>
                    {isVideoSection && items.length >= 2 && (
                      <Button
                        size="sm"
                        variant={selecting ? "outline" : "default"}
                        className="ml-auto h-8 gap-1.5 px-3 text-xs font-medium shadow-sm"
                        onClick={selecting ? exitSelection : enterSelection}
                      >
                        {selecting ? (
                          <>
                            <X className="h-3.5 w-3.5" /> Cancel
                          </>
                        ) : (
                          <>
                            <Scissors className="h-3.5 w-3.5" />
                            Edit (join clips)
                          </>
                        )}
                      </Button>
                    )}
                  </h2>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
                    {items.map((item) => {
                      if (isVideoSection && selecting) {
                        const checked = selectedVideos.includes(item.fileName);
                        const order = checked
                          ? selectedVideos.indexOf(item.fileName) + 1
                          : null;
                        return (
                          <button
                            key={`sel-${item.fileName}`}
                            type="button"
                            onClick={() => toggleSelect(item.fileName)}
                            className={cn(
                              "group relative flex flex-col overflow-hidden rounded-xl border bg-card text-left transition-all",
                              checked
                                ? "border-primary ring-2 ring-primary/40"
                                : "hover:border-muted-foreground/40",
                            )}
                          >
                            <div className="relative aspect-video overflow-hidden bg-muted/40">
                              <video
                                src={generatedMediaUrl(item.fileName)}
                                className="h-full w-full object-cover"
                                muted
                                playsInline
                              />
                              <div className="absolute left-2 top-2 rounded-full bg-black/60 p-1 text-white">
                                {checked ? (
                                  <CheckSquare className="h-4 w-4" />
                                ) : (
                                  <Square className="h-4 w-4" />
                                )}
                              </div>
                              {order !== null && (
                                <div className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground shadow">
                                  {order}
                                </div>
                              )}
                            </div>
                            <div className="p-3">
                              <p
                                className="truncate text-sm font-medium"
                                title={item.prompt ?? item.fileName}
                              >
                                {item.prompt ?? item.fileName}
                              </p>
                            </div>
                          </button>
                        );
                      }
                      return (
                        <GeneratedMediaCard
                          key={`gen-${item.fileName}`}
                          item={item}
                          onDelete={removeItem}
                          isMutating={isMutating}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            })}

            {/* Per-app media (files generated inside specific apps) */}
            {filteredMediaApps.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold">App media</h2>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
                  {filteredMediaApps.map((app) => (
                    <OrianBuilderAppMediaFolder
                      key={`app-${app.appId}`}
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
              </section>
            )}
          </div>
        )}
      </div>

      {/* Floating action bar — appears while videos are being multi-selected. */}
      {selecting && (
        <div className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
          <div className="flex items-center gap-3 rounded-full border bg-background/95 px-4 py-2 shadow-lg backdrop-blur">
            <span className="text-sm">
              <span className="font-semibold">{selectedVideos.length}</span>{" "}
              {selectedVideos.length === 1 ? "video" : "videos"} selected
            </span>
            <Button size="sm" variant="ghost" onClick={exitSelection}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={selectedVideos.length < 2}
              onClick={() => setEditOpen(true)}
            >
              <Scissors className="mr-1.5 h-4 w-4" />
              Edit & join {selectedVideos.length >= 2 ? selectedVideos.length : ""} clips
            </Button>
          </div>
        </div>
      )}

      <VideoEditDialog
        items={selectedItems}
        open={editOpen}
        onOpenChange={setEditOpen}
        onDone={() => {
          setEditOpen(false);
          exitSelection();
        }}
      />
    </div>
  );
}
