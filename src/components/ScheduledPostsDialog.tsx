import { useEffect, useState } from "react";
import {
  Calendar,
  Loader2,
  Youtube,
  Instagram,
  X,
  CheckCircle2,
  AlertCircle,
  Clock,
  ExternalLink,
} from "lucide-react";
import { ipc, type ScheduleJob } from "@/ipc/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { showError, showSuccess } from "@/lib/toast";

/**
 * Queue viewer for scheduled posts. Lists everything in the schedule store,
 * lets the user cancel pending jobs, and exposes the "Run in background"
 * toggle so users can flip on/off the lifecycle change without diving into
 * Settings.
 *
 * Live-updates via the `schedule:changed` event broadcast by the engine.
 */
export function ScheduledPostsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [jobs, setJobs] = useState<ScheduleJob[] | null>(null);
  const [bgEnabled, setBgEnabled] = useState<boolean | null>(null);
  const [togglingBg, setTogglingBg] = useState(false);

  const reload = async () => {
    try {
      const next = await ipc.schedule.list(undefined);
      setJobs(next);
    } catch {
      setJobs([]);
    }
  };

  useEffect(() => {
    if (!open) return;
    void reload();
    void ipc.schedule
      .getBackgroundMode(undefined)
      .then((s) => setBgEnabled(s.enabled))
      .catch(() => setBgEnabled(false));
    const unsub = ipc.events.schedule.onChanged(() => void reload());
    return unsub;
  }, [open]);

  const handleCancel = async (id: string) => {
    try {
      const res = await ipc.schedule.cancel({ id });
      if (res.ok) {
        showSuccess("Cancelled.");
        void reload();
      } else {
        showError("This job has already started — too late to cancel.");
      }
    } catch (err: any) {
      showError(err?.message ?? "Couldn't cancel.");
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await ipc.schedule.remove({ id });
      void reload();
    } catch (err: any) {
      showError(err?.message ?? "Couldn't remove.");
    }
  };

  const handleBgToggle = async (next: boolean) => {
    setTogglingBg(true);
    try {
      const res = await ipc.schedule.setBackgroundMode({ enabled: next });
      setBgEnabled(res.enabled);
      showSuccess(
        next
          ? "Background mode on — OrianBuilder will run in the tray for scheduled posts."
          : "Background mode off — posts only fire while OrianBuilder is open.",
      );
    } catch (err: any) {
      showError(err?.message ?? "Couldn't update background mode.");
    } finally {
      setTogglingBg(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Scheduled posts
          </DialogTitle>
          <DialogDescription>
            Posts queued for later. Cancel any that haven't fired yet.
          </DialogDescription>
        </DialogHeader>

        {/* Background-mode toggle */}
        <div className="flex items-start justify-between gap-3 rounded-3xl border border-border bg-muted/30 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Run in background</p>
            <p className="text-xs text-muted-foreground">
              When on, closing the window minimises to the system tray and
              OrianBuilder starts at login. Scheduled posts fire even if you
              never open the window.
            </p>
          </div>
          <Switch
            checked={bgEnabled === true}
            onCheckedChange={(v) => void handleBgToggle(v)}
            disabled={togglingBg || bgEnabled === null}
          />
        </div>

        <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
          {jobs === null ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : jobs.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
              Nothing scheduled. Open a video's Publish menu to queue one up.
            </div>
          ) : (
            jobs.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                onCancel={handleCancel}
                onRemove={handleRemove}
              />
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JobRow({
  job,
  onCancel,
  onRemove,
}: {
  job: ScheduleJob;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const PlatformIcon = job.platform === "youtube" ? Youtube : Instagram;
  const platformLabel = job.platform === "youtube" ? "YouTube" : "Instagram";
  const platformIconColor =
    job.platform === "youtube" ? "text-red-600" : "text-pink-500";

  const titleOrCaption =
    job.platform === "youtube"
      ? (job.youtube?.title ?? job.fileName)
      : job.instagram?.caption?.slice(0, 80) || job.fileName;

  const statusMeta: Record<
    ScheduleJob["status"],
    { icon: typeof Clock; label: string; cls: string }
  > = {
    pending: {
      icon: Clock,
      label: "Pending",
      cls: "text-sky-600 border-sky-500/30 bg-sky-500/10",
    },
    running: {
      icon: Loader2,
      label: "Running",
      cls: "text-sky-600 border-sky-500/30 bg-sky-500/10",
    },
    done: {
      icon: CheckCircle2,
      label: "Done",
      cls: "text-emerald-600 border-emerald-500/30 bg-emerald-500/10",
    },
    failed: {
      icon: AlertCircle,
      label: "Failed",
      cls: "text-destructive border-destructive/30 bg-destructive/10",
    },
    cancelled: {
      icon: X,
      label: "Cancelled",
      cls: "text-muted-foreground border-border bg-muted/30",
    },
  };
  const meta = statusMeta[job.status];
  const StatusIcon = meta.icon;

  return (
    <div className="rounded-2xl border border-border bg-transparent/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <PlatformIcon
              className={cn("h-4 w-4 shrink-0", platformIconColor)}
            />
            <span className="text-xs font-medium text-muted-foreground">
              {platformLabel}
            </span>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase",
                meta.cls,
              )}
            >
              <StatusIcon
                className={cn(
                  "h-3 w-3",
                  job.status === "running" && "animate-spin",
                )}
              />
              {meta.label}
            </span>
            {job.platform === "youtube" && job.youtube?.privacy && (
              <span className="inline-flex items-center rounded border border-border bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                {job.youtube.privacy}
              </span>
            )}
          </div>
          <p
            className="mt-1 truncate text-sm font-medium"
            title={titleOrCaption}
          >
            {titleOrCaption || "(no title)"}
          </p>
          <p className="text-xs text-muted-foreground">
            {new Date(job.scheduledAt).toLocaleString()}
          </p>
          {job.error && (
            <p
              className="mt-1 truncate text-[11px] text-destructive"
              title={job.error}
            >
              {job.error}
            </p>
          )}
          {job.result && job.platform === "youtube" ? (
            (() => {
              // Private YouTube uploads render as "Video unavailable" on the
              // public watch URL, so we route the owner to YouTube Studio
              // (always works regardless of visibility). Non-private uploads
              // get the regular watch URL too.
              const watchUrl = job.result.url;
              const studioUrl = job.result.videoId
                ? `https://studio.youtube.com/video/${job.result.videoId}/edit`
                : null;
              const isPrivate = job.youtube?.privacy === "private";
              return (
                <div className="mt-1 flex flex-col gap-0.5">
                  {watchUrl && !isPrivate && (
                    <a
                      href={watchUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-primary underline"
                    >
                      View on YouTube <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {studioUrl && (
                    <a
                      href={studioUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] text-primary underline"
                    >
                      Open in YouTube Studio{" "}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {isPrivate && (
                    <p className="text-[10px] text-muted-foreground">
                      Uploaded as private — only you can see it. Use Studio to
                      flip visibility.
                    </p>
                  )}
                </div>
              );
            })()
          ) : job.result?.url ? (
            <a
              href={job.result.url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary underline"
            >
              View on {platformLabel} <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          {job.status === "pending" && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => onCancel(job.id)}
            >
              Cancel
            </Button>
          )}
          {job.status !== "pending" && job.status !== "running" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              onClick={() => onRemove(job.id)}
              title="Remove from list"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
