/**
 * The instruments a task tile can summon, with real content in them.
 *
 * These used to be buttons that said "Open in workspace". That is a navigation
 * affordance dressed as an instrument: the whole premise of the Stage is that
 * you can see the work without going somewhere, and a card that only offers to
 * take you elsewhere is the old nav shell wearing a different shape.
 *
 * Everything here reads from the durable task ledger. Nothing polls a worker
 * directly, so a tile shows the same facts Marta answers from — the rail and her
 * answers cannot disagree.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FileCode2,
  Globe,
  Loader2,
  Monitor,
  RotateCw,
  Smartphone,
  XCircle,
} from "lucide-react";

import type { MartaEvidence, MartaTask } from "@/ipc/types";
import { cn } from "@/lib/utils";

/** Enough width to read a line of output; narrower than this and it is noise. */
const TERMINAL_LINES = 12;

export function InstrumentEmpty({
  label,
  detail,
}: {
  label: string;
  detail: string;
}) {
  return (
    <div className="flex min-h-24 flex-col items-center justify-center px-2 text-center">
      <p className="text-[11px] text-foreground/68">{label}</p>
      <p className="mt-1 text-[9px] leading-[1.4] text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

/**
 * The live app, embedded.
 *
 * A real iframe rather than the screenshot the verifier captured: the screenshot
 * is evidence of a moment, and what a person wants on the Stage while a worker is
 * editing is the thing changing under them. The width presets exist because
 * "does this look right on a phone" is the single most common follow-up question
 * and switching to a device emulator to answer it is absurd.
 */
export function TaskPreviewInstrument({ task }: { task?: MartaTask }) {
  const [width, setWidth] = useState<"fill" | "mobile">("fill");
  const [reloadKey, setReloadKey] = useState(0);
  const url = task?.previewUrl;

  const visual = useMemo(
    () => task?.evidence?.find((item) => item.kind === "screenshot"),
    [task?.evidence],
  );

  if (!url) {
    return (
      <InstrumentEmpty
        label="No preview is serving yet."
        detail={
          task
            ? `${task.title} has not started its app server. Ask Marta to run it.`
            : "Focus a task with a running app first."
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-muted-foreground">
          {url}
        </span>
        <InstrumentIconButton
          label={width === "fill" ? "Preview at phone width" : "Fill the tile"}
          onClick={() => setWidth(width === "fill" ? "mobile" : "fill")}
        >
          {width === "fill" ? (
            <Smartphone className="h-3 w-3" />
          ) : (
            <Monitor className="h-3 w-3" />
          )}
        </InstrumentIconButton>
        <InstrumentIconButton
          label="Reload the preview"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          <RotateCw className="h-3 w-3" />
        </InstrumentIconButton>
      </div>

      <div className="overflow-hidden rounded-[10px] border border-white/[0.08] bg-white">
        <iframe
          // Remounted on demand: a `location.reload()` through the content window
          // is blocked cross-origin for a dev server on another port.
          key={reloadKey}
          title={`Live preview of ${task?.title ?? "the app"}`}
          src={url}
          // The preview runs the user's own code, but it is still code Orion did
          // not write, embedded in the shell that holds their projects.
          sandbox="allow-scripts allow-forms allow-same-origin"
          className={cn(
            "block h-[220px] border-0",
            width === "mobile" ? "mx-auto w-[390px]" : "w-full",
          )}
        />
      </div>

      {visual && (
        <p
          className={cn(
            "flex items-start gap-1.5 text-[9px] leading-[1.45]",
            visual.ok
              ? "text-[var(--cosmos-green)]"
              : "text-[var(--cosmos-amber)]",
          )}
        >
          {visual.ok ? (
            <CheckCircle2 className="mt-[1px] h-3 w-3 shrink-0" />
          ) : (
            <CircleAlert className="mt-[1px] h-3 w-3 shrink-0" />
          )}
          <span className="min-w-0">{visual.detail ?? visual.label}</span>
        </p>
      )}
    </div>
  );
}

/** The worker's own output, tailed. */
export function TaskTerminalInstrument({ task }: { task?: MartaTask }) {
  const lines = task?.terminalTail ?? [];
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  if (lines.length === 0) {
    return (
      <InstrumentEmpty
        label="No terminal output yet."
        detail={
          task
            ? `${task.workerLabel} has not run a command.`
            : "Focus a task to see its shell."
        }
      />
    );
  }

  return (
    <div className="max-h-40 overflow-y-auto rounded-[9px] border border-white/[0.06] bg-black/45 p-2">
      <pre className="whitespace-pre-wrap break-words font-mono text-[9px] leading-[1.5] text-foreground/80">
        {lines.slice(-TERMINAL_LINES).join("\n")}
      </pre>
      <div ref={endRef} />
    </div>
  );
}

function evidenceOfKinds(
  task: MartaTask | undefined,
  kinds: MartaEvidence["kind"][],
): MartaEvidence[] {
  return (task?.evidence ?? []).filter((item) => kinds.includes(item.kind));
}

/**
 * Verification, as Orion observed it.
 *
 * Reads the acceptance evidence rather than the worker's own claim, and labels
 * the source, because "tests pass" from a worker and "tests pass" from Orion are
 * different statements and the distinction is the entire point of the gate.
 */
export function TaskTestsInstrument({ task }: { task?: MartaTask }) {
  const checks = task?.acceptanceEvidence?.checks ?? [];

  if (checks.length === 0) {
    return (
      <InstrumentEmpty
        label={task?.testSummary ?? "No verification has run yet."}
        detail={
          task
            ? "Orion runs build, test, preview and on-screen checks when the worker reports done."
            : "Focus a task to see its acceptance checks."
        }
      />
    );
  }

  return (
    <ol className="flex flex-col gap-1.5" aria-label="Acceptance checks">
      {checks.map((check) => (
        <li key={check.check} className="flex items-start gap-1.5">
          {check.status === "passed" ? (
            <CheckCircle2 className="mt-[2px] h-3 w-3 shrink-0 text-[var(--cosmos-green)]" />
          ) : check.status === "failed" ? (
            <XCircle className="mt-[2px] h-3 w-3 shrink-0 text-[var(--cosmos-red)]" />
          ) : (
            <CircleAlert className="mt-[2px] h-3 w-3 shrink-0 text-[var(--cosmos-amber)]" />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="text-[10px] font-medium capitalize text-foreground/85">
                {check.check}
              </span>
              <span className="font-mono text-[7px] uppercase tracking-[0.1em] text-muted-foreground">
                verified by {check.source}
              </span>
            </span>
            {check.command && (
              <span className="mt-0.5 block truncate font-mono text-[8px] text-muted-foreground/80">
                {check.command}
              </span>
            )}
            {check.detail && (
              <span className="mt-0.5 line-clamp-3 block font-mono text-[8px] leading-[1.45] text-foreground/55">
                {check.detail}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** What is wrong right now: the task error, plus every failed check. */
export function TaskProblemsInstrument({ task }: { task?: MartaTask }) {
  const failed = (task?.acceptanceEvidence?.checks ?? []).filter(
    (check) => check.status === "failed",
  );
  const missing = task?.acceptanceDecision?.missingEvidence ?? [];
  const hasProblem =
    Boolean(task?.error) || failed.length > 0 || missing.length > 0;

  if (!hasProblem) {
    return (
      <InstrumentEmpty
        label="Nothing is failing."
        detail={
          task
            ? `${task.title} has no recorded errors or failed checks.`
            : "Focus a task to see its problems."
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {task?.error && (
        <p className="rounded-[8px] bg-[var(--cosmos-red)]/8 px-2 py-1.5 font-mono text-[9px] leading-[1.45] text-[var(--cosmos-red)]">
          {task.error}
        </p>
      )}
      {failed.map((check) => (
        <p
          key={check.check}
          className="rounded-[8px] bg-white/[0.03] px-2 py-1.5 text-[9px] leading-[1.45] text-foreground/70"
        >
          <span className="font-medium capitalize text-foreground/90">
            {check.check}
          </span>{" "}
          — {check.detail ?? "failed with no detail."}
        </p>
      ))}
      {missing.length > 0 && (
        <p className="text-[9px] leading-[1.45] text-[var(--cosmos-amber)]">
          Still missing: {missing.join(", ")}.
        </p>
      )}
    </div>
  );
}

/** The files Orion saw change, not the ones the worker said it changed. */
export function TaskFilesInstrument({ task }: { task?: MartaTask }) {
  const relevant = task?.acceptanceDecision?.relevantChangedFiles ?? [];
  const observed = task?.acceptanceEvidence?.observedChangedFiles ?? [];
  const files = relevant.length > 0 ? relevant : observed;

  if (files.length === 0) {
    return (
      <InstrumentEmpty
        label={task?.activeFile ?? "No file changes observed."}
        detail={
          task
            ? "Orion compares a pre-task snapshot with the workspace; nothing has changed yet."
            : "Focus a task to see the files it touched."
        }
      />
    );
  }

  const ignored = observed.filter((file) => !relevant.includes(file));

  return (
    <div className="flex flex-col gap-1.5">
      <ul
        className="max-h-32 space-y-1 overflow-y-auto"
        aria-label="Changed files"
      >
        {files.slice(0, 40).map((file) => (
          <li key={file} className="flex items-center gap-1.5">
            <FileCode2 className="h-3 w-3 shrink-0 text-primary/70" />
            <span
              className="min-w-0 flex-1 truncate font-mono text-[9px] text-foreground/78"
              title={file}
            >
              {file}
            </span>
          </li>
        ))}
      </ul>
      {relevant.length > 0 && ignored.length > 0 && (
        // Naming the out-of-scope writes is how a user sees the orphan-file
        // failure at a glance instead of reading an acceptance rejection.
        <p className="text-[8px] leading-[1.45] text-muted-foreground">
          {ignored.length} other change{ignored.length === 1 ? "" : "s"} fell
          outside the task's target paths.
        </p>
      )}
    </div>
  );
}

/** Sources, with whether the body was actually read. */
export function TaskResearchInstrument({ task }: { task?: MartaTask }) {
  const sources = evidenceOfKinds(task, ["artifact"]).filter((item) =>
    item.uri?.startsWith("http"),
  );

  if (sources.length === 0) {
    return (
      <InstrumentEmpty
        label={
          task?.status === "running"
            ? "Searching and reading sources…"
            : "No research sources yet."
        }
        detail={
          task
            ? "Ask Marta to research something; every URL she reads is recorded here."
            : "Say “research the latest Godot release” to start one."
        }
      />
    );
  }

  return (
    <ul
      className="max-h-40 space-y-1.5 overflow-y-auto"
      aria-label="Research sources"
    >
      {sources.map((source) => (
        <li key={source.id} className="flex items-start gap-1.5">
          <Globe
            className={cn(
              "mt-[2px] h-3 w-3 shrink-0",
              source.ok
                ? "text-[var(--cosmos-green)]"
                : "text-muted-foreground",
            )}
          />
          <span className="min-w-0 flex-1">
            <a
              href={source.uri}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1 text-[10px] leading-[1.4] text-foreground/80 hover:text-primary"
            >
              <span className="min-w-0 truncate">{source.label}</span>
              <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
            </a>
            <span className="mt-0.5 block truncate font-mono text-[7px] uppercase tracking-[0.08em] text-muted-foreground">
              {source.detail}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A verification summary line, used by the workspace header and task tiles. */
export function AcceptanceBadge({ task }: { task: MartaTask }) {
  const decision = task.acceptanceDecision;
  if (!decision) {
    if (task.status === "running" && task.activeTool === "Orion verifier") {
      return (
        <Badge tone="pending">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          Verifying
        </Badge>
      );
    }
    return null;
  }
  if (decision.accepted) {
    return (
      <Badge tone="ok">
        <CheckCircle2 className="h-2.5 w-2.5" />
        Verified by Orion
      </Badge>
    );
  }
  return (
    <Badge tone="bad">
      <XCircle className="h-2.5 w-2.5" />
      {decision.failedChecks.length > 0
        ? `${decision.failedChecks.join(", ")} failed`
        : "Evidence missing"}
    </Badge>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "ok" | "bad" | "pending";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.08em]",
        tone === "ok" &&
          "bg-[color-mix(in_srgb,var(--cosmos-green)_14%,transparent)] text-[var(--cosmos-green)]",
        tone === "bad" &&
          "bg-[color-mix(in_srgb,var(--cosmos-red)_14%,transparent)] text-[var(--cosmos-red)]",
        tone === "pending" && "bg-primary/12 text-primary",
      )}
    >
      {children}
    </span>
  );
}

function InstrumentIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
    >
      {children}
    </button>
  );
}
