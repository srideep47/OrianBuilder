import { useEffect, useState } from "react";
import { Youtube, Loader2, ExternalLink, CheckCircle2 } from "lucide-react";
import {
  ipc,
  type GeneratedMediaItem,
  type YouTubePrivacy,
  type YouTubeStatus,
} from "@/ipc/types";
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
  const [privacy, setPrivacy] = useState<YouTubePrivacy>("private");
  const [publishing, setPublishing] = useState(false);
  const [percent, setPercent] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  // Reset + load connection status whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle(item));
    setDescription(item.prompt?.trim() ?? "");
    setPrivacy("private");
    setPublishing(false);
    setPercent(0);
    setResultUrl(null);
    void ipc.youtube
      .getStatus(undefined)
      .then(setStatus)
      .catch(() => setStatus(null));
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
        ) : resultUrl ? (
          // Success state.
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2 text-sm font-medium text-green-600">
              <CheckCircle2 className="h-5 w-5" />
              Published successfully
            </div>
            <a
              href={resultUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary underline"
            >
              View on YouTube <ExternalLink className="h-3.5 w-3.5" />
            </a>
            {privacy === "private" && (
              <p className="text-xs text-muted-foreground">
                The video is private. Unverified Google API projects upload as
                private — change visibility in YouTube Studio, or verify your
                project to publish publicly.
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          // Publish form.
          <div className="space-y-3">
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
                  "border-input bg-transparent dark:bg-input/30 flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs outline-none disabled:opacity-50",
                )}
              >
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </select>
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
                    Publishing…
                  </>
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
