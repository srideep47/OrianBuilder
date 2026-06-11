import { useState } from "react";
import {
  Users,
  ImageIcon,
  Film,
  Music,
  Box,
  Download,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useSharedMedia } from "@/hooks/useSharedMedia";
import type { SharedMediaMeta, SharedPeerCatalog } from "@/ipc/types";

const KIND_ICON = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  model: Box,
} as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SharedItemCard({
  item,
  onDownload,
  progress,
}: {
  item: SharedMediaMeta;
  onDownload: () => void;
  progress?: {
    status: "downloading" | "done" | "error";
    received: number;
    total: number;
    error: string | null;
  };
}) {
  const KindIcon = KIND_ICON[item.kind];
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.received / progress.total) * 100))
      : 0;
  const isDownloading = progress?.status === "downloading";
  const isDone = progress?.status === "done";

  return (
    <div className="group flex flex-col overflow-hidden rounded-3xl border bg-card">
      <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-muted/40">
        {item.thumbnail ? (
          <img
            src={item.thumbnail}
            alt={item.prompt ?? item.fileName}
            className="h-full w-full object-cover"
          />
        ) : (
          <KindIcon className="h-8 w-8 text-muted-foreground/50" />
        )}
        <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
          <KindIcon className="h-3 w-3" />
          {item.kind}
        </span>
      </div>

      <div className="flex flex-col gap-2 p-3">
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

        {isDone ? (
          <span className="flex items-center justify-center gap-1.5 rounded-3xl bg-green-500/10 py-1.5 text-xs font-medium text-green-500">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Downloaded to your library
          </span>
        ) : isDownloading ? (
          <div className="flex flex-col gap-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-center text-[11px] text-muted-foreground">
              Downloading… {pct}%
            </span>
          </div>
        ) : progress?.status === "error" ? (
          <Button size="sm" variant="outline" onClick={onDownload}>
            <AlertTriangle className="mr-1.5 h-3.5 w-3.5 text-red-500" />
            Retry download
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={onDownload}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Download
          </Button>
        )}
      </div>
    </div>
  );
}

function PeerSection({
  catalog,
  getDownload,
  onDownload,
}: {
  catalog: SharedPeerCatalog;
  getDownload: (
    peerKey: string,
    fileName: string,
  ) => ReturnType<typeof useSharedMedia>["downloads"][string] | undefined;
  onDownload: (peerKey: string, fileName: string) => void;
}) {
  if (catalog.items.length === 0) return null;
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Users className="h-4 w-4 text-muted-foreground" />
        {catalog.displayName}
        <span className="text-xs font-normal text-muted-foreground">
          ({catalog.items.length})
        </span>
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
        {catalog.items.map((item) => (
          <SharedItemCard
            key={`${catalog.peerKey}-${item.fileName}`}
            item={item}
            progress={getDownload(catalog.peerKey, item.fileName)}
            onDownload={() => onDownload(catalog.peerKey, item.fileName)}
          />
        ))}
      </div>
    </section>
  );
}

export default function SharedContentPage() {
  const { peers, isLoading, getDownload, download, refresh } = useSharedMedia();
  const [refreshing, setRefreshing] = useState(false);

  const handleDownload = async (peerKey: string, fileName: string) => {
    const res = await download(peerKey, fileName);
    if (!res.ok) toast.error(res.message);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setTimeout(() => setRefreshing(false), 800);
    }
  };

  const hasContent = peers.some((p) => p.items.length > 0);

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="flex items-center justify-between border-b px-6 pb-4 pt-6">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-base font-semibold">Shared Content</h1>
            <p className="text-xs text-muted-foreground">
              Media shared by people in your network
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
          />
        </Button>
      </div>

      <div className="flex-1 px-6 py-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !hasContent ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <Users className="h-10 w-10 text-muted-foreground/30" />
            <div>
              <p className="text-sm font-medium">Nothing shared yet</p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                When people in your network (Network tab) mark media as
                sharable, it appears here. You must both be online and connected
                as trusted peers.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-8">
            {peers.map((catalog) => (
              <PeerSection
                key={catalog.peerKey}
                catalog={catalog}
                getDownload={getDownload}
                onDownload={(pk, fn) => void handleDownload(pk, fn)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
