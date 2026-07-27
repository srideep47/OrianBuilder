import { useState } from "react";
import {
  Users,
  ImageIcon,
  Film,
  Music,
  Box,
  Download,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { SpaceHeader } from "@/shell/SpaceHeader";
import {
  EmptyState,
  LBadge,
  LButton,
  LIconButton,
  LoadingState,
  LProgress,
  PageShell,
  Surface,
} from "@/components/liquid";
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
    <Surface corner="md" className="flex flex-col overflow-hidden">
      <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-black/25">
        {item.thumbnail ? (
          <img
            src={item.thumbnail}
            alt={item.prompt ?? item.fileName}
            className="h-full w-full object-cover"
          />
        ) : (
          <KindIcon className="h-8 w-8 text-muted-foreground/50" />
        )}
        <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
          <KindIcon className="h-3 w-3" />
          {item.kind}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-3">
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-[13px] font-medium text-foreground"
            title={item.prompt ?? item.fileName}
          >
            {item.prompt ?? item.fileName}
          </p>
          <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {formatBytes(item.sizeBytes)}
          </p>
        </div>

        {isDone ? (
          <LBadge tone="success" className="justify-center py-1">
            <CheckCircle2 className="h-3.5 w-3.5" />
            In your library
          </LBadge>
        ) : isDownloading ? (
          <div className="flex flex-col gap-1.5">
            <LProgress value={pct / 100} label="Download progress" />
            <span className="text-center font-mono text-[11px] tabular-nums text-muted-foreground">
              {pct}%
            </span>
          </div>
        ) : progress?.status === "error" ? (
          <LButton
            size="compact"
            tone="glass"
            block
            onClick={onDownload}
            icon={
              <AlertTriangle className="text-[var(--cosmos-red)]" aria-hidden />
            }
          >
            Retry
          </LButton>
        ) : (
          <LButton
            size="compact"
            tone="glass"
            block
            onClick={onDownload}
            icon={<Download />}
          >
            Download
          </LButton>
        )}
      </div>
    </Surface>
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
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2 className="truncate text-[15px] font-semibold tracking-[-0.006em] text-foreground">
          {catalog.displayName}
        </h2>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {catalog.items.length}
        </span>
      </div>
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

  const sharedCount = peers.reduce((total, p) => total + p.items.length, 0);

  return (
    <PageShell
      width="wide"
      header={
        <SpaceHeader
          meta={
            sharedCount > 0 ? (
              <LBadge tone="neutral">
                {sharedCount} from {peers.length}{" "}
                {peers.length === 1 ? "peer" : "peers"}
              </LBadge>
            ) : undefined
          }
          actions={
            <LIconButton
              label="Refresh shared content"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
            >
              <RefreshCw className={cn(refreshing && "animate-spin")} />
            </LIconButton>
          }
        />
      }
    >
      <div>
        {isLoading ? (
          <LoadingState label="shared content" />
        ) : !hasContent ? (
          <EmptyState
            icon={<Users />}
            title="Nothing shared yet"
            description="When a trusted peer marks media as sharable it appears here. Both of you need to be online and connected — set that up in Hub → Peers."
          />
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
    </PageShell>
  );
}
