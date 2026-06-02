import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/ipc/types";
import type { SharedDownloadProgress } from "@/ipc/types";

const SHARED_MEDIA_KEY = ["shared-media-catalog"] as const;

/** Key a download by peer + file. */
function dlKey(peerKey: string, fileName: string): string {
  return `${peerKey}:${fileName}`;
}

/**
 * Browses media shared by trusted peers over the P2P network and tracks
 * download progress. Catalog updates arrive via events; downloads stream into
 * the local library.
 */
export function useSharedMedia() {
  const queryClient = useQueryClient();
  const [downloads, setDownloads] = useState<Record<string, SharedDownloadProgress>>({});

  const query = useQuery({
    queryKey: SHARED_MEDIA_KEY,
    queryFn: () => ipc.sharedMedia.getCatalog(),
    staleTime: 2_000,
  });

  useEffect(() => {
    const unsubCatalog = ipc.events.sharedMedia.onCatalogChanged((payload) => {
      queryClient.setQueryData(SHARED_MEDIA_KEY, payload.peers);
    });
    const unsubProgress = ipc.events.sharedMedia.onDownloadProgress((p) => {
      setDownloads((prev) => ({ ...prev, [dlKey(p.peerKey, p.fileName)]: p }));
    });
    return () => {
      unsubCatalog();
      unsubProgress();
    };
  }, [queryClient]);

  const download = (peerKey: string, fileName: string) =>
    ipc.sharedMedia.download({ peerKey, fileName });

  const refresh = () => ipc.sharedMedia.refresh();

  return {
    peers: query.data ?? [],
    isLoading: query.isLoading,
    downloads,
    getDownload: (peerKey: string, fileName: string) =>
      downloads[dlKey(peerKey, fileName)],
    download,
    refresh,
  };
}
