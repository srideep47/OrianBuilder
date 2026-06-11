import { useState } from "react";
import {
  Trash2,
  Film,
  ImageIcon,
  Music,
  Box,
  X,
  ZoomIn,
  Share2,
  Youtube,
  Instagram,
  Send,
  ChevronDown,
} from "lucide-react";
import { ipc, generatedMediaUrl, type GeneratedMediaItem } from "@/ipc/types";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PublishToYouTubeDialog } from "@/components/PublishToYouTubeDialog";
import { PublishToInstagramDialog } from "@/components/PublishToInstagramDialog";
import { ScheduledPostsDialog } from "@/components/ScheduledPostsDialog";
import { toast } from "sonner";
import { Calendar } from "lucide-react";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const KIND_ICON = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  model: Box,
} as const;

/** Downscale an image/video element to a small JPEG data URL for peer announce. */
async function generateThumbnail(
  src: string,
  kind: "image" | "video",
): Promise<string | null> {
  try {
    const maxDim = 256;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    if (kind === "image") {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error("img load"));
        img.src = src;
      });
      const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } else {
      const video = document.createElement("video");
      video.muted = true;
      video.src = src;
      await new Promise<void>((res, rej) => {
        video.onloadeddata = () => res();
        video.onerror = () => rej(new Error("video load"));
      });
      const scale = Math.min(
        maxDim / video.videoWidth,
        maxDim / video.videoHeight,
        1,
      );
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
    return canvas.toDataURL("image/jpeg", 0.6);
  } catch {
    return null;
  }
}

function LightboxImage({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
      onClick={onClose}
    >
      <button
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        onClick={onClose}
      >
        <X className="h-5 w-5" />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

function LightboxVideo({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 p-4"
      onClick={onClose}
    >
      <button
        className="absolute right-4 top-4 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        onClick={onClose}
      >
        <X className="h-5 w-5" />
      </button>
      <video
        src={src}
        className="max-h-full max-w-full rounded-lg shadow-2xl"
        controls
        autoPlay
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

export function GeneratedMediaCard({
  item,
  onDelete,
  isMutating,
}: {
  item: GeneratedMediaItem;
  onDelete: (fileName: string) => void;
  isMutating: boolean;
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [instagramOpen, setInstagramOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const src = generatedMediaUrl(item.fileName);
  const KindIcon = KIND_ICON[item.kind];

  const handleToggleShare = async (next: boolean) => {
    setSharing(true);
    try {
      // When enabling sharing, attach a thumbnail so peers can preview it.
      if (
        next &&
        !item.thumbnail &&
        (item.kind === "image" || item.kind === "video")
      ) {
        const thumb = await generateThumbnail(src, item.kind);
        if (thumb)
          await ipc.generatedMedia.setThumbnail({
            fileName: item.fileName,
            thumbnail: thumb,
          });
      }
      await ipc.generatedMedia.setShared({
        fileName: item.fileName,
        shared: next,
      });
      toast.success(next ? "Shared with your network" : "Stopped sharing");
    } catch {
      toast.error("Failed to update sharing");
    } finally {
      setSharing(false);
    }
  };

  return (
    <>
      <div className="group flex flex-col overflow-hidden rounded-xl border bg-card">
        {/* Preview */}
        <div
          className="relative flex aspect-video cursor-pointer items-center justify-center overflow-hidden bg-muted/40"
          onClick={() => {
            if (item.kind === "image" && !imgError) setLightboxOpen(true);
            else if (item.kind === "video") setLightboxOpen(true);
          }}
        >
          {item.kind === "image" && !imgError ? (
            <>
              <img
                src={src}
                alt={item.prompt ?? item.fileName}
                className="h-full w-full object-cover"
                onError={() => setImgError(true)}
              />
              <div className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
                <div className="rounded-full bg-black/60 p-2">
                  <ZoomIn className="h-5 w-5 text-white" />
                </div>
              </div>
            </>
          ) : item.kind === "video" ? (
            <>
              <video
                src={src}
                className="h-full w-full object-cover"
                muted
                loop
                playsInline
                onMouseEnter={(e) =>
                  void e.currentTarget.play().catch(() => undefined)
                }
                onMouseLeave={(e) => {
                  e.currentTarget.pause();
                  e.currentTarget.currentTime = 0;
                }}
              />
              <div
                className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightboxOpen(true);
                }}
              >
                <div className="rounded-full bg-black/60 p-2">
                  <ZoomIn className="h-5 w-5 text-white" />
                </div>
              </div>
            </>
          ) : item.kind === "audio" ? (
            <audio src={src} controls className="w-full px-3" />
          ) : (
            // model / broken image → icon placeholder
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <KindIcon className="h-8 w-8 opacity-50" />
              <p className="text-xs">
                {item.kind === "model" ? "3D model" : "Preview unavailable"}
              </p>
            </div>
          )}

          <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
            <KindIcon className="h-3 w-3" />
            {item.kind}
          </span>
        </div>

        {/* Meta + actions */}
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p
                className="truncate text-sm font-medium"
                title={item.prompt ?? item.fileName}
              >
                {item.prompt ?? item.fileName}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(item.sizeBytes)}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
              onClick={() => onDelete(item.fileName)}
              disabled={isMutating}
              title="Remove from library"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Sharable toggle */}
          <div className="flex items-center justify-between rounded-md bg-muted/40 px-2.5 py-1.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Share2 className="h-3.5 w-3.5" />
              {item.shared ? "Shared with network" : "Share with network"}
            </span>
            <Switch
              checked={item.shared}
              onCheckedChange={(v) => void handleToggleShare(v)}
              disabled={sharing}
            />
          </div>

          {/* Publish — videos only. YouTube uploads directly; Instagram
              opens a share-assist flow because IG has no desktop upload API. */}
          {item.kind === "video" && (
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-input bg-transparent px-3 text-xs font-medium shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
                <Send className="h-3.5 w-3.5" />
                Publish
                <ChevronDown className="h-3.5 w-3.5 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => setPublishOpen(true)}>
                  <Youtube className="h-4 w-4 text-red-600" />
                  YouTube
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setInstagramOpen(true)}>
                  <Instagram className="h-4 w-4 text-pink-500" />
                  Instagram
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setScheduleOpen(true)}>
                  <Calendar className="h-4 w-4" />
                  Scheduled posts…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {item.kind === "video" && (
        <>
          <PublishToYouTubeDialog
            item={item}
            open={publishOpen}
            onOpenChange={setPublishOpen}
          />
          <PublishToInstagramDialog
            item={item}
            open={instagramOpen}
            onOpenChange={setInstagramOpen}
          />
          <ScheduledPostsDialog
            open={scheduleOpen}
            onOpenChange={setScheduleOpen}
          />
        </>
      )}

      {lightboxOpen && item.kind === "image" && (
        <LightboxImage
          src={src}
          alt={item.prompt ?? item.fileName}
          onClose={() => setLightboxOpen(false)}
        />
      )}

      {lightboxOpen && item.kind === "video" && (
        <LightboxVideo src={src} onClose={() => setLightboxOpen(false)} />
      )}
    </>
  );
}
