import { useEffect, useState, type ReactElement } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Cpu,
  FileCode2,
  Gauge,
  Loader2,
} from "lucide-react";

import { PreviewPanel } from "@/components/preview_panel/PreviewPanel";
import type { MartaTask } from "@/ipc/types";
import { cn } from "@/lib/utils";
import { AcceptanceBadge, TaskTestsInstrument } from "./TaskInstruments";

type WorkspaceTask = MartaTask & { activeFile?: string };

/** The focused task's full workspace: context remains visible above every tool. */
export function TaskWorkspace({ task }: { task?: MartaTask }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!task || task.completedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [task]);

  const telemetry = task as WorkspaceTask | undefined;
  const tokenCount = (task?.inputTokens ?? 0) + (task?.outputTokens ?? 0);
  const active = task?.status === "running" || task?.status === "queued";
  const failed = task?.status === "failed";

  return (
    <div className="flex h-full min-w-0 flex-col bg-[linear-gradient(180deg,color-mix(in_srgb,var(--cosmos-deep)_35%,transparent),transparent_18%)]">
      <header
        className="flex min-h-12 shrink-0 items-center gap-3 border-b border-white/[0.07] bg-[color-mix(in_srgb,var(--cosmos-deep)_42%,transparent)] px-3 py-2 backdrop-blur-xl"
        aria-label="Focused task context"
      >
        <span
          className={cn(
            "grid h-8 w-8 shrink-0 place-items-center rounded-[10px]",
            failed
              ? "bg-[var(--cosmos-red)]/12 text-[var(--cosmos-red)]"
              : "bg-primary/10 text-primary",
          )}
        >
          {active ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : failed ? (
            <CircleAlert className="h-4 w-4" />
          ) : (
            <CheckCircle2 className="h-4 w-4" />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold text-foreground">
            {task?.title ?? "Project workspace"}
          </span>
          <span className="mt-0.5 block truncate text-[9px] text-muted-foreground">
            {task
              ? `${task.workerLabel} · ${task.phase ?? task.status}`
              : "Preview, source, terminal, diagnostics and delivery in one place"}
          </span>
        </span>

        {task && (
          <div className="hidden min-w-0 items-stretch gap-px overflow-hidden rounded-[9px] border border-white/[0.06] bg-white/[0.06] min-[900px]:flex">
            <WorkspaceMetric
              icon={<FileCode2 />}
              label="File"
              value={telemetry?.activeFile ?? "Awaiting activity"}
            />
            <WorkspaceMetric
              icon={<Gauge />}
              label="Tool"
              value={task.activeTool ?? "Idle"}
            />
            <WorkspaceMetric
              icon={<Cpu />}
              label="Model"
              value={task.model ?? "Default"}
            />
            <WorkspaceMetric
              icon={<Activity />}
              label="Tokens"
              value={tokenCount > 0 ? tokenCount.toLocaleString() : "—"}
            />
            <WorkspaceMetric
              icon={<Clock3 />}
              label="Elapsed"
              value={formatElapsed((task.completedAt ?? now) - task.createdAt)}
            />
          </div>
        )}

        {task && (
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="rounded-full border border-white/[0.08] bg-white/[0.035] px-2 py-1 font-mono text-[8px] uppercase tracking-[0.08em] text-foreground/55">
              {task.status}
            </span>
            <AcceptanceBadge task={task} />
          </span>
        )}
      </header>

      {/* Why the task is (or is not) done, above the tools rather than buried in
          a card on another surface. A rejected completion has to be the first
          thing you read here, otherwise the preview below looks like a success. */}
      {task?.acceptanceDecision && !task.acceptanceDecision.accepted && (
        <div
          className="shrink-0 border-b border-[color-mix(in_srgb,var(--cosmos-red)_28%,transparent)] bg-[color-mix(in_srgb,var(--cosmos-red)_8%,transparent)] px-3 py-2"
          aria-label="Acceptance rejection"
        >
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--cosmos-red)]">
            Orion did not certify this result
          </p>
          <p className="mt-0.5 text-[11px] leading-[1.45] text-foreground/78">
            {task.error ??
              [
                ...task.acceptanceDecision.failedChecks.map(
                  (check) => `${check} failed`,
                ),
                ...task.acceptanceDecision.missingEvidence,
              ].join(", ")}
          </p>
        </div>
      )}

      {/* Only once there is something to report. An empty "no verification yet"
          block would occupy the same space as the answer and say nothing. */}
      {(task?.acceptanceEvidence?.checks.length ?? 0) > 0 && (
        <div className="max-h-32 shrink-0 overflow-y-auto border-b border-white/[0.07] px-3 py-2">
          <TaskTestsInstrument task={task} />
        </div>
      )}

      <div className="min-h-0 flex-1">
        <PreviewPanel />
      </div>
    </div>
  );
}

function WorkspaceMetric({
  icon,
  label,
  value,
}: {
  icon: ReactElement<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <span className="min-w-20 max-w-36 bg-[color-mix(in_srgb,var(--cosmos-deep)_78%,transparent)] px-2 py-1">
      <span className="flex items-center gap-1 text-[7px] uppercase tracking-[0.08em] text-muted-foreground">
        {icon}
        {label}
      </span>
      <span
        className="mt-0.5 block truncate font-mono text-[8px] text-foreground/72"
        title={value}
      >
        {value}
      </span>
    </span>
  );
}

function formatElapsed(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
