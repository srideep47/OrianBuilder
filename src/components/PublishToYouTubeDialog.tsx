import { useEffect, useState } from "react";
import {
  Youtube,
  Loader2,
  ExternalLink,
  CheckCircle2,
  Clock,
  Send,
} from "lucide-react";
import {
  ipc,
  type GeneratedMediaItem,
  type YouTubePrivacy,
  type YouTubeStatus,
} from "@/ipc/types";
import { SchedulePicker } from "@/components/SchedulePicker";
import { showSuccess } from "@/lib/toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { showError } from "@/lib/toast";
import { useNavigate } from "@tanstack/react-router";

function defaultTitle(item: GeneratedMediaItem): string {
  const base = item.prompt?.trim() || item.fileName;
  return base.slice(0, 100);
}

export function PublishToYouTubeDialog({
  item,
  open,
  onOpenChange,
}: {
  item: GeneratedMediaItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<YouTubeStatus | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Default to "unlisted": viewable by anyone with the link, not surfaced
  // publicly. This is what users almost always want for AI-generated test
  // uploads and avoids the "Video unavailable / This video is private" trap
  // that happens with the previous `private` default. Unverified Google
  // Cloud projects can still publish as unlisted (only `public` is gated by
  // verification).
  const [privacy, setPrivacy] = useState<YouTubePrivacy>("unlisted");
  const [publishing, setPublishing] = useState(false);
  const [percent, setPercent] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  /** "now" → upload immediately; "schedule" → queue for `scheduledAt`. */
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState<number | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const [bgEnabled, setBgEnabled] = useState<boolean | null>(null);

  // Reset + load connection status whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle(item));
    setDescription(item.prompt?.trim() ?? "");
    setPrivacy("unlisted");
    setPublishing(false);
    setPercent(0);
    setResultUrl(null);
    setMode("now");
    setScheduledAt(null);
    setScheduled(false);
    void ipc.youtube
      .getStatus(undefined)
      .then(setStatus)
      .catch(() => setStatus(null));
    void ipc.schedule
      .getBackgroundMode(undefined)
      .then((s) => setBgEnabled(s.enabled))
      .catch(() => setBgEnabled(false));
  }, [open, item]);

  // Live upload progress for this specific file.
  useEffect(() => {
    if (!publishing) return;
    const unsub = ipc.events.youtube.onPublishProgress((p) => {
      if (p.fileName === item.fileName) setPercent(p.percent);
    });
    return unsub;
  }, [publishing, item.fileName]);

  const handlePublish = async () => {
    if (!title.trim()) {
      showError("A title is required.");
      return;
    }

    // Schedule path: persist the job in the queue and bow out. The main-
    // process engine picks it up when the scheduled time arrives.
    if (mode === "schedule") {
      if (!scheduledAt) {
        showError("Pick a date and time for the scheduled post.");
        return;
      }
      setPublishing(true);
      try {
        await ipc.schedule.scheduleYouTube({
          fileName: item.fileName,
          scheduledAt,
          title: title.trim(),
          description: description.trim() || undefined,
          privacy,
        });
        setScheduled(true);
        showSuccess("Scheduled. We'll publish it at the chosen time.");
      } catch (err: any) {
        showError(err?.message ?? "Failed to schedule the YouTube post.");
      } finally {
        setPublishing(false);
      }
      return;
    }

    setPublishing(true);
    setPercent(0);
    try {
      const res = await ipc.youtube.publish({
        fileName: item.fileName,
        title: title.trim(),
        description: description.trim() || undefined,
        privacy,
      });
      setResultUrl(res.url);
    } catch (err: any) {
      showError(err?.message ?? "Failed to publish to YouTube.");
      setPublishing(false);
    }
  };

  const notConnected = status !== null && !status.connected;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Youtube className="h-5 w-5 text-red-600" />
            Publish to YouTube
          </DialogTitle>
          <DialogDescription>
            Upload this video to your connected channel.
          </DialogDescription>
        </DialogHeader>

        {/* Not connected → send the user to Settings. */}
        {notConnected ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              {status?.hasCredentials
                ? "Your YouTube credentials are saved, but no channel is connected yet."
                : "Connect a YouTube channel before publishing."}
            </p>
            <Button
              onClick={() => {
                onOpenChange(false);
                void navigate({ to: "/settings" });
              }}
            >
              Open Settings
            </Button>
          </div>
        ) : scheduled ? (
          // Scheduled success state.
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2 text-sm font-medium text-green-600">
              <CheckCircle2 className="h-5 w-5" />
              Scheduled
            </div>
            <p className="text-sm text-muted-foreground">
              We'll publish this to YouTube on{" "}
              <span className="font-medium text-foreground">
                {scheduledAt ? new Date(scheduledAt).toLocaleString() : ""}
              </span>
              .
            </p>
            {bgEnabled === false && (
              <p className="rounded-3xl border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                Heads up: "Run in background" is off in Settings, so the upload
                only fires if OrianBuilder is open at the scheduled time.
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : resultUrl ? (
          // Success state.
          (() => {
            // Private videos render as "Video unavailable" on the public
            // watch URL — link to YouTube Studio instead, where the owner
            // can preview AND flip visibility. Unlisted / public uploads
            // get the regular watch URL.
            const videoId = resultUrl.split("v=")[1]?.split("&")[0] ?? "";
            const studioUrl = videoId
              ? `https://studio.youtube.com/video/${videoId}/edit`
              : null;
            return (
              <div className="space-y-3 py-2">
                <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                  <CheckCircle2 className="h-5 w-5" />
                  Published successfully
                </div>
                <div className="flex flex-col gap-1.5">
                  {privacy !== "private" && (
                    <a
                      href={resultUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-primary underline"
                    >
                      View on YouTube <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {studioUrl && (
                    <a
                      href={studioUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-primary underline"
                    >
                      Open in YouTube Studio{" "}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
                {privacy === "private" && (
                  <p className="rounded-3xl border border-sky-500/30 bg-sky-500/5 px-2.5 py-1.5 text-xs text-sky-800 dark:text-sky-300">
                    The video is private — only you can see it. Open YouTube
                    Studio (above) to preview it or flip visibility to
                    Unlisted/Public.
                  </p>
                )}
                <DialogFooter>
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Done
                  </Button>
                </DialogFooter>
              </div>
            );
          })()
        ) : (
          // Publish form.
          <div className="space-y-3">
            {/* When-to-publish toggle */}
            <div className="inline-flex rounded-2xl border border-border bg-transparent/50 p-0.5">
              <button
                type="button"
                onClick={() => setMode("now")}
                disabled={publishing}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-3xl px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
                  mode === "now"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Send className="h-3.5 w-3.5" />
                Publish now
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("schedule");
                  // Default to "in 1h" when the user first switches to schedule
                  // mode so they don't have to pick a time from scratch.
                  if (!scheduledAt) setScheduledAt(Date.now() + 60 * 60 * 1000);
                }}
                disabled={publishing}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-3xl px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
                  mode === "schedule"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Clock className="h-3.5 w-3.5" />
                Schedule
              </button>
            </div>

            {mode === "schedule" && (
              <>
                <SchedulePicker
                  value={scheduledAt}
                  onChange={setScheduledAt}
                  disabled={publishing}
                />
                {bgEnabled === false && (
                  <p className="rounded-3xl border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                    "Run in background" is off in Settings — scheduled posts
                    only fire when OrianBuilder is open. Turn it on to upload
                    even with the app closed.
                  </p>
                )}
              </>
            )}

            <div>
              <Label htmlFor="yt-title" className="text-xs">
                Title
              </Label>
              <Input
                id="yt-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={100}
                disabled={publishing}
              />
            </div>
            <div>
              <Label htmlFor="yt-desc" className="text-xs">
                Description
              </Label>
              <Textarea
                id="yt-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                maxLength={5000}
                disabled={publishing}
              />
            </div>
            <div>
              <Label htmlFor="yt-privacy" className="text-xs">
                Visibility
              </Label>
              <select
                id="yt-privacy"
                value={privacy}
                onChange={(e) => setPrivacy(e.target.value as YouTubePrivacy)}
                disabled={publishing}
                className={cn(
                  "border-input bg-transparent dark:bg-input/30 flex h-9 w-full rounded-3xl border px-3 py-1 text-sm shadow-xs outline-none disabled:opacity-50",
                )}
              >
                <option value="unlisted">
                  Unlisted — anyone with the link
                </option>
                <option value="public">Public — listed on your channel</option>
                <option value="private">Private — only you</option>
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {privacy === "private" &&
                  "Private videos show 'Video unavailable' to everyone except the owner."}
                {privacy === "unlisted" &&
                  "Unlisted is the safe default: viewable by anyone with the link, not surfaced publicly."}
                {privacy === "public" &&
                  "Public requires a verified Google Cloud project, otherwise YouTube silently downgrades to private."}
              </p>
            </div>

            {publishing && (
              <div className="space-y-1.5">
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-red-600 transition-all"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Uploading… {percent}%
                </p>
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={publishing}
              >
                Cancel
              </Button>
              <Button onClick={handlePublish} disabled={publishing}>
                {publishing ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    {mode === "schedule" ? "Scheduling…" : "Publishing…"}
                  </>
                ) : mode === "schedule" ? (
                  "Schedule"
                ) : (
                  "Publish"
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
