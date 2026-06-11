import { useCallback, useEffect, useState } from "react";
import { HardDrive, Loader2, Trash2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ipc } from "@/ipc/types";
import type { ModelJunkScan } from "@/ipc/types/media_ai";

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Storage panel for the Orion page: shows how much disk space is locked up by
 * downloaded models and how much can be reclaimed from half-finished downloads,
 * with a one-click "Clean up wasted space" action.
 */
export function OrionStoragePanel() {
  const [scan, setScan] = useState<ModelJunkScan | null>(null);
  const [diskInfo, setDiskInfo] = useState<{
    totalBytes: number;
    freeBytes: number;
  } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  const refresh = useCallback(async () => {
    setScanning(true);
    try {
      const [junk, info] = await Promise.all([
        ipc.mediaAi.scanModelJunk(),
        ipc.marketplace.getModelsDirInfo().catch(() => null),
      ]);
      setScan(junk);
      if (info) setDiskInfo(info);
    } catch {
      /* non-fatal: panel just shows nothing */
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reclaimable = scan?.totalBytes ?? 0;
  const junkCount = scan?.items.length ?? 0;

  const handleCleanup = useCallback(async () => {
    if (reclaimable <= 0 && junkCount === 0) {
      toast.info("Nothing to clean up — no wasted space found.");
      return;
    }
    if (
      !window.confirm(
        `Clean up wasted space?\n\n` +
          `${junkCount} leftover item(s) (~${formatBytes(reclaimable)}) from ` +
          `half-finished downloads will be removed. Your downloaded models are not touched.`,
      )
    ) {
      return;
    }
    setCleaning(true);
    try {
      const result = await ipc.mediaAi.cleanModelJunk();
      toast.success(
        result.freedBytes > 0
          ? `Freed ${formatBytes(result.freedBytes)} (${result.removed.length} items removed)`
          : `Removed ${result.removed.length} leftover items`,
      );
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(false);
    }
  }, [reclaimable, junkCount, refresh]);

  return (
    <div className="w-full rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-2xl bg-sky-500/20 text-sky-300">
          <HardDrive className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-white/90">Storage</h3>
          <p className="text-xs text-white/50">
            Reclaim disk space from half-finished or abandoned model downloads.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={scanning || cleaning}
          className="text-white/40 hover:text-white/70 disabled:opacity-50"
          title="Re-scan"
        >
          <RefreshCw className={`h-4 w-4 ${scanning ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-3xl border border-white/10 bg-black/20 p-3">
          <div className="text-[11px] uppercase tracking-wide text-white/40">
            Models on disk
          </div>
          <div className="mt-0.5 text-sm font-semibold text-white/85">
            {diskInfo ? formatBytes(diskInfo.totalBytes) : "—"}
          </div>
        </div>
        <div className="rounded-3xl border border-white/10 bg-black/20 p-3">
          <div className="text-[11px] uppercase tracking-wide text-white/40">
            Free space
          </div>
          <div className="mt-0.5 text-sm font-semibold text-white/85">
            {diskInfo ? formatBytes(diskInfo.freeBytes) : "—"}
          </div>
        </div>
        <div className="rounded-3xl border border-white/10 bg-black/20 p-3">
          <div className="text-[11px] uppercase tracking-wide text-white/40">
            Reclaimable
          </div>
          <div
            className={`mt-0.5 text-sm font-semibold ${
              reclaimable > 0 ? "text-amber-300" : "text-white/85"
            }`}
          >
            {scanning ? "…" : formatBytes(reclaimable)}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={scanning || cleaning}
          onClick={() => void handleCleanup()}
          className="gap-1.5"
        >
          {cleaning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
          Clean up wasted space
        </Button>
        {junkCount > 0 && !scanning && (
          <span className="text-xs text-white/45">
            {junkCount} leftover item{junkCount === 1 ? "" : "s"} found
          </span>
        )}
      </div>
    </div>
  );
}
