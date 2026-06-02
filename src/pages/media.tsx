import { useState, useMemo } from "react";
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
} from "lucide-react";
import { OrianBuilderAppMediaFolder } from "@/components/OrianBuilderAppMediaFolder";
import { GeneratedMediaCard } from "@/components/GeneratedMediaCard";
import { LibrarySearchBar } from "@/components/LibrarySearchBar";
import { Button } from "@/components/ui/button";
import { filterMediaAppsByQuery } from "@/lib/mediaUtils";
import { useNavigate } from "@tanstack/react-router";
import type { GeneratedMediaKind } from "@/ipc/types";

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
      <div className="flex-1 px-6 py-4">
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
              return (
                <section key={kind}>
                  <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {label}
                    <span className="text-xs font-normal text-muted-foreground">
                      ({items.length})
                    </span>
                  </h2>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
                    {items.map((item) => (
                      <GeneratedMediaCard
                        key={`gen-${item.fileName}`}
                        item={item}
                        onDelete={removeItem}
                        isMutating={isMutating}
                      />
                    ))}
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
    </div>
  );
}
