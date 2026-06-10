import { useEffect, useRef, useState } from "react";
import {
  Instagram,
  CheckCircle2,
  Copy,
  FolderOpen,
  ExternalLink,
  Clock,
  Send,
  Info,
} from "lucide-react";
import {
  ipc,
  generatedMediaUrl,
  type GeneratedMediaItem,
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { showError, showSuccess } from "@/lib/toast";
import { SchedulePicker } from "@/components/SchedulePicker";
import { cn } from "@/lib/utils";

/**
 * Instagram has no desktop-upload API — uploads must go through their mobile
 * app, or a server using the Graph API + a publicly hosted video URL with a
 * Facebook Business account. None of those work from a local Electron app.
 *
 * This dialog is therefore a "guided manual upload":
 *   1. Show the user a preview of which video is about to be shared.
 *   2. Copy the caption to the clipboard.
 *   3. Reveal the video file in the OS file manager.
 *   4. Open instagram.com in the default browser.
 *   5. **Keep the dialog open** with the step-by-step instructions visible
 *      so the user can refer back to them while doing the Instagram side,
 *      and offer re-trigger buttons for each step in case something closes.
 *
 * Why the previous "paste the caption" approach confused users: Instagram's
 * caption input only appears *after* the video is uploaded via their file
 * picker. Trying to paste on the home screen has nowhere to land — there's
 * no caption box yet. The new copy is explicit about the order.
 */
export function PublishToInstagramDialog({
  item,
  open,
  onOpenChange,
}: {
  item: GeneratedMediaItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  /** True once the user has clicked "Open" — switches the UI to the
   *  step-by-step guide. */
  const [started, setStarted] = useState(false);
  const [mode, setMode] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState<number | null>(null);
  const [scheduled, setScheduled] = useState(false);
  const [bgEnabled, setBgEnabled] = useState<boolean | null>(null);
  /** Resolved on-demand for the file-reveal buttons; cached so we don't
   *  hit IPC every click. */
  const absPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCaption(item.prompt?.trim() ?? "");
    setBusy(false);
    setStarted(false);
    setMode("now");
    setScheduledAt(null);
    setScheduled(false);
    absPathRef.current = null;
    void ipc.schedule
      .getBackgroundMode(undefined)
      .then((s) => setBgEnabled(s.enabled))
      .catch(() => setBgEnabled(false));
  }, [open, item]);

  // ---------- Helpers used both by the initial Start click and the
  //            re-trigger buttons on the persistent guide. ----------

  const copyCaption = async (silent = false): Promise<boolean> => {
    if (!caption.trim()) return false;
    try {
      await navigator.clipboard.writeText(caption.trim());
      if (!silent) showSuccess("Caption copied to clipboard.");
      return true;
    } catch {
      if (!silent) showError("Couldn't copy caption.");
      return false;
    }
  };

  const revealFile = async (silent = false): Promise<void> => {
    try {
      let p = absPathRef.current;
      if (!p) {
        const res = await ipc.generatedMedia.getFilePath({
          fileName: item.fileName,
        });
        p = res.path;
        absPathRef.current = p;
      }
      await ipc.system.showItemInFolder(p);
      if (!silent) showSuccess("Opened the folder containing your video.");
    } catch (err: any) {
      if (!silent)
        showError(err?.message ?? "Couldn't open the video's folder.");
    }
  };

  const openInstagram = async (silent = false): Promise<void> => {
    try {
      await ipc.system.openExternalUrl("https://www.instagram.com/");
      if (!silent) showSuccess("Instagram opened in your browser.");
    } catch (err: any) {
      if (!silent) showError(err?.message ?? "Couldn't open Instagram.");
    }
  };

  // ---------- Submit handlers ----------

  const handleStart = async () => {
    setBusy(true);
    try {
      // Run all three preparations. Each is independent so a failure in one
      // doesn't block the others.
      await copyCaption(true);
      await revealFile(true);
      await openInstagram(true);
      setStarted(true);
    } finally {
      setBusy(false);
    }
  };

  const handleSchedule = async () => {
    if (!scheduledAt) {
      showError("Pick a date and time for the scheduled post.");
      return;
    }
    setBusy(true);
    try {
      await ipc.schedule.scheduleInstagram({
        fileName: item.fileName,
        scheduledAt,
        caption: caption.trim(),
      });
      setScheduled(true);
      showSuccess(
        "Scheduled. We'll remind you and open this dialog at that time.",
      );
    } catch (err: any) {
      showError(err?.message ?? "Failed to schedule the Instagram post.");
    } finally {
      setBusy(false);
    }
  };

  // ---------- Render ----------

  const videoSrc = generatedMediaUrl(item.fileName);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Instagram className="h-5 w-5 text-pink-500" />
            Share to Instagram
          </DialogTitle>
          <DialogDescription>
            Instagram has no API for desktop apps — we'll prep everything and
            walk you through the upload.
          </DialogDescription>
        </DialogHeader>

        {/* Tiny video preview so the user is certain which file is being shared. */}
        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 p-2">
          <video
            src={videoSrc}
            className="h-16 w-24 shrink-0 rounded object-cover"
            muted
            loop
            playsInline
            onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
            onMouseLeave={(e) => {
              e.currentTarget.pause();
              e.currentTarget.currentTime = 0;
            }}
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" title={item.fileName}>
              {item.prompt?.trim() || item.fileName}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {item.fileName}
            </p>
          </div>
        </div>

        {scheduled ? (
          <ScheduledBranch
            scheduledAt={scheduledAt}
            bgEnabled={bgEnabled}
            onClose={() => onOpenChange(false)}
          />
        ) : started ? (
          <StartedBranch
            onCopyCaption={() => void copyCaption()}
            onRevealFile={() => void revealFile()}
            onReopenInstagram={() => void openInstagram()}
            onClose={() => onOpenChange(false)}
            hasCaption={!!caption.trim()}
          />
        ) : (
          <FormBranch
            caption={caption}
            setCaption={setCaption}
            mode={mode}
            setMode={(m) => {
              setMode(m);
              if (m === "schedule" && !scheduledAt) {
                setScheduledAt(Date.now() + 60 * 60 * 1000);
              }
            }}
            scheduledAt={scheduledAt}
            setScheduledAt={setScheduledAt}
            bgEnabled={bgEnabled}
            busy={busy}
            onCopyCaption={() => void copyCaption()}
            onCancel={() => onOpenChange(false)}
            onPrimary={() => void (mode === "schedule" ? handleSchedule() : handleStart())}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// Branch: editable form before the user clicks Start.
// =============================================================================
function FormBranch({
  caption,
  setCaption,
  mode,
  setMode,
  scheduledAt,
  setScheduledAt,
  bgEnabled,
  busy,
  onCopyCaption,
  onCancel,
  onPrimary,
}: {
  caption: string;
  setCaption: (s: string) => void;
  mode: "now" | "schedule";
  setMode: (m: "now" | "schedule") => void;
  scheduledAt: number | null;
  setScheduledAt: (ms: number | null) => void;
  bgEnabled: boolean | null;
  busy: boolean;
  onCopyCaption: () => void;
  onCancel: () => void;
  onPrimary: () => void;
}) {
  return (
    <div className="space-y-3">
      {/* Now vs. Schedule toggle */}
      <div className="inline-flex rounded-lg border border-border bg-background/50 p-0.5">
        <ModeButton
          active={mode === "now"}
          disabled={busy}
          onClick={() => setMode("now")}
          icon={Send}
          label="Share now"
        />
        <ModeButton
          active={mode === "schedule"}
          disabled={busy}
          onClick={() => setMode("schedule")}
          icon={Clock}
          label="Schedule"
        />
      </div>

      {mode === "schedule" && (
        <>
          <SchedulePicker
            value={scheduledAt}
            onChange={setScheduledAt}
            disabled={busy}
          />
          {bgEnabled === false && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
              "Run in background" is off in Settings — scheduled reminders only
              fire when OrianBuilder is open.
            </p>
          )}
        </>
      )}

      {/* Why this isn't automated. We surface the platform constraint up-front
          so the next dialog state (the step-by-step guide) doesn't feel like
          a surprise. */}
      <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-2.5 text-[11px] text-sky-800 dark:text-sky-300">
        <p className="flex items-start gap-1.5">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Instagram doesn't allow desktop apps to upload videos directly.
            Click <strong>Open Instagram</strong> below and we'll open the
            file's folder and your browser, then walk you through the final
            three clicks on Instagram.
          </span>
        </p>
      </div>

      <div>
        <Label htmlFor="ig-caption" className="text-xs">
          Caption
        </Label>
        <Textarea
          id="ig-caption"
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          rows={4}
          maxLength={2200}
          placeholder="Write a caption…"
          disabled={busy}
        />
        <div className="mt-1 flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground">
            Captions cap at 2,200 characters.
          </p>
          <button
            type="button"
            className="text-[11px] text-primary underline-offset-2 hover:underline disabled:opacity-50"
            onClick={onCopyCaption}
            disabled={!caption.trim() || busy}
          >
            <Copy className="mr-1 inline-block h-3 w-3" />
            Copy only
          </button>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={onPrimary} disabled={busy}>
          {busy
            ? mode === "schedule"
              ? "Scheduling…"
              : "Preparing…"
            : mode === "schedule"
              ? "Schedule"
              : "Open Instagram"}
        </Button>
      </DialogFooter>
    </div>
  );
}

// =============================================================================
// Branch: persistent step-by-step guide after the user clicked Start.
// =============================================================================
function StartedBranch({
  onCopyCaption,
  onRevealFile,
  onReopenInstagram,
  onClose,
  hasCaption,
}: {
  onCopyCaption: () => void;
  onRevealFile: () => void;
  onReopenInstagram: () => void;
  onClose: () => void;
  hasCaption: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium text-green-600">
        <CheckCircle2 className="h-5 w-5" />
        Folder + browser are open — finish on Instagram
      </div>

      <ol className="space-y-2 text-sm">
        <Step
          n={1}
          title="On Instagram, click the + (Create) button"
          help="Top bar on desktop. If you weren't signed in, log in first."
        >
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={onReopenInstagram}
          >
            <ExternalLink className="mr-1 h-3 w-3" />
            Reopen Instagram
          </Button>
        </Step>

        <Step
          n={2}
          title="Choose 'Select from computer' and pick your video"
          help="Drop-down on the Create dialog. The file is highlighted in the folder we opened for you."
        >
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={onRevealFile}
          >
            <FolderOpen className="mr-1 h-3 w-3" />
            Reopen folder
          </Button>
        </Step>

        <Step
          n={3}
          title="On the caption screen, paste your caption"
          help={
            hasCaption
              ? "Right-click → Paste, or Ctrl+V. The caption is already in your clipboard."
              : "(You didn't write a caption — skip this step.)"
          }
        >
          {hasCaption && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={onCopyCaption}
            >
              <Copy className="mr-1 h-3 w-3" />
              Copy caption again
            </Button>
          )}
        </Step>

        <Step
          n={4}
          title="Click Share on Instagram"
          help="You're done."
        />
      </ol>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </div>
  );
}

// =============================================================================
// Branch: scheduled-success state.
// =============================================================================
function ScheduledBranch({
  scheduledAt,
  bgEnabled,
  onClose,
}: {
  scheduledAt: number | null;
  bgEnabled: boolean | null;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3 py-2">
      <div className="flex items-center gap-2 text-sm font-medium text-green-600">
        <CheckCircle2 className="h-5 w-5" />
        Scheduled
      </div>
      <p className="text-sm text-muted-foreground">
        On{" "}
        <span className="font-medium text-foreground">
          {scheduledAt ? new Date(scheduledAt).toLocaleString() : ""}
        </span>
        , OrianBuilder will notify you and re-open this dialog with the file
        revealed, the browser open, and the caption ready.
      </p>
      {bgEnabled === false && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          "Run in background" is off — the reminder only fires if OrianBuilder
          is open at the scheduled time.
        </p>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

// =============================================================================
// Tiny presentational helpers.
// =============================================================================
function ModeButton({
  active,
  disabled,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function Step({
  n,
  title,
  help,
  children,
}: {
  n: number;
  title: string;
  help?: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-semibold text-primary">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium leading-tight">{title}</p>
        {help && (
          <p className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
            {help}
          </p>
        )}
        {children && <div className="mt-1.5">{children}</div>}
      </div>
    </li>
  );
}
