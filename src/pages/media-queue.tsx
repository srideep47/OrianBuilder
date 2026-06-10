import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ListVideo,
  ImageIcon,
  Film,
  Music,
  Mic,
  Clapperboard,
  Loader2,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Trash2,
  Ban,
  Plus,
  Monitor,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ipc } from "@/ipc/types";
import type { MediaJob, MediaJobKind, MediaAspectRatio } from "@/ipc/types";

const QUEUE_KEY = ["media-queue-jobs"] as const;

const KIND_META: Record<
  MediaJobKind,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  image: { label: "Image", icon: ImageIcon },
  video: { label: "Video", icon: Film },
  music: { label: "Music", icon: Music },
  speech: { label: "Speech", icon: Mic },
  video_audio: { label: "Video + Audio", icon: Clapperboard },
  storyboard: { label: "Storyboard (script → video)", icon: ListVideo },
};

const ASPECT_RATIOS: MediaAspectRatio[] = ["16:9", "9:16", "1:1", "4:3", "3:4"];

function StatusBadge({ job }: { job: MediaJob }) {
  switch (job.status) {
    case "queued":
      return (
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          queued
        </span>
      );
    case "running":
      return (
        <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          <Loader2 className="h-3 w-3 animate-spin" />
          {job.stage ? `running · ${job.stage}` : "running"}
        </span>
      );
    case "done":
      return (
        <span className="flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-500">
          <CheckCircle2 className="h-3 w-3" />
          done
        </span>
      );
    case "failed":
      return (
        <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
          <XCircle className="h-3 w-3" />
          failed
        </span>
      );
    case "cancelled":
      return (
        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          cancelled
        </span>
      );
  }
}

function JobRow({
  job,
  onCancel,
  onRetry,
  onRemove,
}: {
  job: MediaJob;
  onCancel: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const KindIcon = KIND_META[job.kind].icon;
  const isRemote = job.hostedBy !== "local";
  const fromPeer = job.requestedBy.source === "peer";

  return (
    <div className="flex items-start gap-3 rounded-xl border bg-card p-3">
      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        <KindIcon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium" title={job.prompt}>
            {job.prompt}
          </p>
          <StatusBadge job={job} />
        </div>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{KIND_META[job.kind].label}</span>
          <span>· {job.aspectRatio}</span>
          {job.durationSec ? <span>· {job.durationSec}s</span> : null}
          {isRemote ? (
            <span className="flex items-center gap-1">
              · <Users className="h-3 w-3" /> runs on {job.hostLabel ?? "peer"}
            </span>
          ) : null}
          {fromPeer ? (
            <span className="flex items-center gap-1">
              · <Users className="h-3 w-3" /> from{" "}
              {job.requestedBy.displayName ?? "friend"}
            </span>
          ) : null}
        </p>
        {job.kind === "video_audio" && job.audioPrompt ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {job.audioKind === "speech" ? "Narration" : "Music"}:{" "}
            {job.audioPrompt}
          </p>
        ) : null}
        {job.scenes?.length ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {job.scenes.map((s) => (
              <span
                key={s.index}
                title={`${s.index}. ${s.title}`}
                className={cn(
                  "h-2.5 w-2.5 rounded-full",
                  s.status === "done"
                    ? "bg-green-500"
                    : s.status === "generating"
                      ? "animate-pulse bg-primary"
                      : s.status === "failed"
                        ? "bg-destructive"
                        : "bg-muted-foreground/30",
                )}
              />
            ))}
            <span className="ml-1 text-[11px] text-muted-foreground">
              {job.scenes.filter((s) => s.status === "done").length}/
              {job.scenes.length} scenes
            </span>
          </div>
        ) : null}
        {job.error ? (
          <p className="mt-1 text-xs text-destructive">{job.error}</p>
        ) : null}
        {job.status === "done" && job.outputFileNames?.length ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {isRemote
              ? "Ready on the host device — grab it from Library → Shared Content."
              : "Saved to Library → Media."}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {(job.status === "queued" || job.status === "running") && !isRemote ? (
          <Button variant="ghost" size="icon" title="Cancel" onClick={onCancel}>
            <Ban className="h-4 w-4" />
          </Button>
        ) : null}
        {(job.status === "failed" || job.status === "cancelled") &&
        !isRemote ? (
          <Button variant="ghost" size="icon" title="Retry" onClick={onRetry}>
            <RotateCcw className="h-4 w-4" />
          </Button>
        ) : null}
        {job.status !== "running" ? (
          <Button variant="ghost" size="icon" title="Remove" onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export default function MediaQueuePage() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<MediaJobKind>("video_audio");
  const [prompt, setPrompt] = useState("");
  const [audioKind, setAudioKind] = useState<"music" | "speech">("music");
  const [audioPrompt, setAudioPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<MediaAspectRatio>("16:9");
  const [durationSec, setDurationSec] = useState<string>("");
  const [target, setTarget] = useState<string>("local");
  const [submitting, setSubmitting] = useState(false);

  const jobsQuery = useQuery({
    queryKey: QUEUE_KEY,
    queryFn: () => ipc.mediaQueue.list(),
    staleTime: 1_000,
  });

  const networkQuery = useQuery({
    queryKey: ["media-queue-network-status"],
    queryFn: () => ipc.network.getStatus(),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    const unsub = ipc.events.mediaQueue.onChanged((payload) => {
      queryClient.setQueryData(QUEUE_KEY, payload.jobs);
    });
    return unsub;
  }, [queryClient]);

  const peers = useMemo(
    () =>
      (networkQuery.data?.peers ?? []).filter(
        (p) => p.isTrusted && p.status === "online",
      ),
    [networkQuery.data],
  );

  const jobs = jobsQuery.data ?? [];
  const isStoryboard = kind === "storyboard";
  const needsAudio = kind === "video_audio" || isStoryboard;
  const needsDuration = kind !== "image" && !isStoryboard;

  const submit = async () => {
    if (!prompt.trim()) {
      toast.error("Write a prompt first.");
      return;
    }
    setSubmitting(true);
    try {
      const duration = Number(durationSec);
      await ipc.mediaQueue.enqueue({
        kind,
        prompt: prompt.trim(),
        audioPrompt: needsAudio ? audioPrompt.trim() || undefined : undefined,
        audioKind: needsAudio ? audioKind : undefined,
        aspectRatio,
        durationSec:
          needsDuration && Number.isFinite(duration) && duration > 0
            ? duration
            : undefined,
        targetPeerId: target === "local" ? undefined : target,
      });
      setPrompt("");
      setAudioPrompt("");
      toast.success("Added to the queue.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const act = async (
    fn: () => Promise<{ ok: boolean }>,
    failMsg: string,
  ): Promise<void> => {
    const { ok } = await fn();
    if (!ok) toast.error(failMsg);
  };

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-6 overflow-y-auto p-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <ListVideo className="h-5 w-5" />
          Media Queue
        </h1>
        <p className="text-sm text-muted-foreground">
          Queue prompts with targets — each job is generated one at a time.
          Friends can submit to your queue, and you can submit to theirs.
        </p>
      </div>

      {/* Submission form */}
      <div className="flex flex-col gap-4 rounded-xl border bg-card p-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label>Type</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as MediaJobKind)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_META) as MediaJobKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_META[k].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Aspect ratio</Label>
            <Select
              value={aspectRatio}
              onValueChange={(v) => setAspectRatio(v as MediaAspectRatio)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASPECT_RATIOS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Duration (s)</Label>
            <Input
              type="number"
              min={1}
              max={600}
              placeholder={needsDuration ? "e.g. 8" : "n/a for images"}
              disabled={!needsDuration}
              value={durationSec}
              onChange={(e) => setDurationSec(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Prompt</Label>
          <Textarea
            placeholder={
              isStoryboard
                ? `Paste a multi-scene script. Example:\n\nStyle: Bright 2D cartoon animation, vibrant colors\nScene 1: Intro (0:08 - 0:24)\nPrompt: A bright underwater coral reef with friendly fish…\nScene 2: Baby Shark (0:24 - 0:32)\nPrompt: A cute yellow cartoon baby shark swimming…\n\nEach scene is generated separately, auto-edited together in order, and a matched soundtrack is added.`
                : kind === "speech"
                  ? "Text to speak…"
                  : kind === "music"
                    ? "Music style, mood, instruments…"
                    : "Describe what to generate…"
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={isStoryboard ? 10 : 3}
          />
        </div>

        {needsAudio ? (
          <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
            <div className="flex flex-col gap-1.5">
              <Label>Audio track</Label>
              <Select
                value={audioKind}
                onValueChange={(v) => setAudioKind(v as "music" | "speech")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="music">Music</SelectItem>
                  <SelectItem value="speech">Narration</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>
                {audioKind === "speech"
                  ? "Narration text"
                  : "Music prompt (optional — matched to the video by default)"}
              </Label>
              <Input
                placeholder={
                  audioKind === "speech"
                    ? "What the voice should say…"
                    : "e.g. upbeat lo-fi with soft drums"
                }
                value={audioPrompt}
                onChange={(e) => setAudioPrompt(e.target.value)}
              />
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-56 flex-col gap-1.5">
            <Label>Run on</Label>
            <Select
              value={target}
              onValueChange={(v) => setTarget(v ?? "local")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">
                  <span className="flex items-center gap-2">
                    <Monitor className="h-3.5 w-3.5" /> This device
                  </span>
                </SelectItem>
                {peers.map((p) => (
                  <SelectItem key={p.publicKey} value={p.publicKey}>
                    <span className="flex items-center gap-2">
                      <Users className="h-3.5 w-3.5" />
                      {p.displayName} · {p.deviceName}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-1.5 h-4 w-4" />
            )}
            Add to queue
          </Button>
        </div>
      </div>

      {/* Job list */}
      <div className="flex flex-col gap-2 pb-6">
        {jobs.length === 0 ? (
          <p
            className={cn(
              "rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground",
            )}
          >
            Nothing queued yet — add a prompt above. Finished media lands in
            Library → Media.
          </p>
        ) : (
          jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              onCancel={() =>
                act(
                  () => ipc.mediaQueue.cancel({ jobId: job.id }),
                  "Couldn't cancel that job.",
                )
              }
              onRetry={() =>
                act(
                  () => ipc.mediaQueue.retry({ jobId: job.id }),
                  "Couldn't retry that job.",
                )
              }
              onRemove={() =>
                act(
                  () => ipc.mediaQueue.remove({ jobId: job.id }),
                  "Couldn't remove that job.",
                )
              }
            />
          ))
        )}
      </div>
    </div>
  );
}
