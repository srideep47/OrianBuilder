import { useEffect, useState } from "react";
import {
  Film,
  Loader2,
  ArrowUp,
  ArrowDown,
  X,
  CheckCircle2,
  Scissors,
} from "lucide-react";
import { ipc, generatedMediaUrl, type GeneratedMediaItem } from "@/ipc/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { showError, showSuccess } from "@/lib/toast";

interface VideoEditDialogProps {
  items: GeneratedMediaItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}

/**
 * Lets the user reorder a set of selected videos and concatenate them into a
 * single new clip. Wraps `ipc.generatedMedia.concatVideos` and surfaces
 * progress + the resulting library item.
 */
export function VideoEditDialog({
  items,
  open,
  onOpenChange,
  onDone,
}: VideoEditDialogProps) {
  const [ordered, setOrdered] = useState<GeneratedMediaItem[]>(items);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<GeneratedMediaItem | null>(null);

  useEffect(() => {
    if (open) {
      setOrdered(items);
      setRunning(false);
      setResult(null);
    }
  }, [open, items]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= ordered.length) return;
    const next = ordered.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setOrdered(next);
  };

  const remove = (idx: number) => {
    setOrdered((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleRun = async () => {
    if (ordered.length < 2) {
      showError("Pick at least 2 videos to join");
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const promptSummary = ordered
        .map((i) => i.prompt ?? i.fileName)
        .join(" + ")
        .slice(0, 200);
      const saved = await ipc.generatedMedia.concatVideos({
        fileNames: ordered.map((i) => i.fileName),
        mode: "reencode",
        targetFps: 24,
        prompt: `Edit: ${promptSummary}`,
      });
      setResult(saved);
      showSuccess("Videos joined — added to your library");
      onDone?.();
    } catch (err) {
      showError(err);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="h-4 w-4 text-primary" />
            Edit videos — concatenate
          </DialogTitle>
          <DialogDescription>
            Reorder the clips below. They will be joined in this order into a
            single new video. Different resolutions are normalised to 1280×720 @
            24fps.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <p className="text-sm font-medium">Saved to your library</p>
            <video
              src={generatedMediaUrl(result.fileName)}
              className="max-h-72 w-full rounded-3xl border bg-black object-contain"
              controls
              autoPlay
            />
          </div>
        ) : (
          <div className="flex max-h-[420px] flex-col gap-2 overflow-y-auto pr-1">
            {ordered.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No videos selected.
              </p>
            ) : (
              ordered.map((item, idx) => (
                <div
                  key={item.fileName}
                  className="flex items-center gap-3 rounded-3xl border bg-card p-2"
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    {idx + 1}
                  </div>
                  <video
                    src={generatedMediaUrl(item.fileName)}
                    className="h-14 w-24 shrink-0 rounded bg-black object-cover"
                    muted
                    onMouseEnter={(e) =>
                      void e.currentTarget.play().catch(() => undefined)
                    }
                    onMouseLeave={(e) => {
                      e.currentTarget.pause();
                      e.currentTarget.currentTime = 0;
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-sm font-medium"
                      title={item.prompt ?? item.fileName}
                    >
                      {item.prompt ?? item.fileName}
                    </p>
                    <p className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Film className="h-3 w-3" />
                      {item.fileName}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={idx === 0 || running}
                      onClick={() => move(idx, idx - 1)}
                      title="Move up"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={idx === ordered.length - 1 || running}
                      onClick={() => move(idx, idx + 1)}
                      title="Move down"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={running}
                      onClick={() => remove(idx)}
                      title="Remove from sequence"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              onClick={() => void handleRun()}
              disabled={running || ordered.length < 2}
            >
              {running ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Joining…
                </>
              ) : (
                <>
                  <Scissors className="mr-1.5 h-4 w-4" />
                  Join {ordered.length} clips
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
