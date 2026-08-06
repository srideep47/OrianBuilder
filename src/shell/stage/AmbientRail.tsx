/**
 * The ambient rail: what is happening that you did not ask about just now.
 *
 * It is primarily a status projection, but a running task is also the most
 * direct handle for focusing its workspace. The rail only exists while work is
 * active (or has just completed), so it never becomes a second app menu.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  CircleDotDashed,
  LayoutGrid,
  Loader2,
  Maximize2,
  PackageCheck,
  Workflow,
  XCircle,
} from "lucide-react";

import {
  ipc,
  type FlowActivity,
  type MartaTask,
  type MartaWorldState,
} from "@/ipc/types";
import { previewModeAtom, selectedAppIdAtom } from "@/atoms/appAtoms";
import { isPreviewOpenAtom } from "@/atoms/viewAtoms";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { material, radius } from "@/components/liquid";
import { martaModelStatusAtom } from "./presence_state";
import { focusSurfaceAtom } from "./stage_state";
import { focusedTaskIdAtom } from "./task_state";
import {
  dismissFluidSurfaceAtom,
  fluidSurfacesAtom,
  projectedMartaTasksAtom,
  taskDeckCollapsedAtom,
  taskSurfaceEmphasisAtom,
} from "./workspace_state";
import { TaskDeck, type TaskInstrument } from "./TaskDeck";

/**
 * The digest is the same thing Marta reads each turn, so the rail and her
 * answers can never disagree about what is running.
 */
const REFRESH_MS = 3_000;
const COMPLETED_LINGER_MS = 20_000;

interface FlowLane {
  flowId: string;
  goal: string;
  status: "running" | "completed";
  updatedAt: number;
  steps: Record<string, FlowActivity>;
  artifacts: FlowActivity[];
}

export function AmbientRail() {
  const queryClient = useQueryClient();
  const model = useAtomValue(martaModelStatusAtom);
  const focusedTaskId = useAtomValue(focusedTaskIdAtom);
  const fluidSurfaces = useAtomValue(fluidSurfacesAtom);
  const emphasis = useAtomValue(taskSurfaceEmphasisAtom);
  const collapsed = useAtomValue(taskDeckCollapsedAtom);
  const setFocusedTaskId = useSetAtom(focusedTaskIdAtom);
  const setProjectedTasks = useSetAtom(projectedMartaTasksAtom);
  const setCollapsed = useSetAtom(taskDeckCollapsedAtom);
  const setEmphasis = useSetAtom(taskSurfaceEmphasisAtom);
  const dismissFluidSurface = useSetAtom(dismissFluidSurfaceAtom);
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const setPreviewMode = useSetAtom(previewModeAtom);
  const setPreviewOpen = useSetAtom(isPreviewOpenAtom);
  const focusSurface = useSetAtom(focusSurfaceAtom);
  const { data } = useQuery({
    queryKey: queryKeys.marta.worldState(),
    queryFn: () => ipc.marta.getWorldState(),
    refetchInterval: REFRESH_MS,
  });

  const state = data?.state as MartaWorldState | undefined;
  const running = state?.running ?? [];
  const { data: taskData } = useQuery({
    queryKey: queryKeys.marta.tasks(),
    queryFn: () => ipc.marta.listTasks({ includeCompleted: true, limit: 30 }),
    refetchInterval: 1_000,
  });
  const tasks = useMemo(
    () =>
      (taskData?.tasks ?? []).filter(
        (task) =>
          !["succeeded", "failed", "cancelled"].includes(task.status) ||
          Date.now() - task.updatedAt < COMPLETED_LINGER_MS,
      ),
    [taskData?.tasks],
  );
  useEffect(() => setProjectedTasks(tasks), [setProjectedTasks, tasks]);

  const needsHardware = fluidSurfaces.some(
    (surface) => surface.id === "gpu" || surface.id === "pc",
  );
  const needsResidency = fluidSurfaces.some(
    (surface) => surface.id === "gpu" || surface.id === "models",
  );
  const { data: hardware } = useQuery({
    queryKey: ["stage", "hardware-profile"],
    queryFn: () => ipc.hardware.getProfile(),
    staleTime: 30_000,
    enabled: needsHardware,
  });
  const { data: residency } = useQuery({
    queryKey: ["stage", "marta-residency"],
    queryFn: () => ipc.marta.getResidency(),
    refetchInterval: 3_000,
    enabled: needsResidency,
  });
  // Sampled only while a telemetry surface is on the Stage. `nvidia-smi` costs
  // a process spawn per sample, so an always-on poller would burn CPU to
  // populate a panel nobody is looking at.
  const { data: live } = useQuery({
    queryKey: ["stage", "live-telemetry"],
    queryFn: () => ipc.telemetry.getLiveSample(),
    refetchInterval: 1_000,
    enabled: needsHardware,
  });
  const { data: inference } = useQuery({
    queryKey: ["stage", "inference-telemetry"],
    queryFn: () => ipc.telemetry.getInference(),
    refetchInterval: 1_500,
    enabled: fluidSurfaces.some((surface) => surface.id === "models"),
  });
  const demoted = model.running && model.placement === "cpu";
  const [flowLanes, setFlowLanes] = useState<Record<string, FlowLane>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () =>
      ipc.events.flow.onActivity((activity) => {
        setFlowLanes((previous) => {
          const lane = previous[activity.flowId] ?? {
            flowId: activity.flowId,
            goal: activity.goal,
            status: "running" as const,
            updatedAt: activity.timestamp,
            steps: {},
            artifacts: [],
          };
          const steps = { ...lane.steps };
          if (activity.stepId && !activity.artifact) {
            steps[activity.stepId] = activity;
          }
          const artifacts = activity.artifact
            ? [
                ...lane.artifacts.filter(
                  (item) => item.artifact?.id !== activity.artifact?.id,
                ),
                activity,
              ].slice(-4)
            : lane.artifacts;
          return {
            ...previous,
            [activity.flowId]: {
              ...lane,
              goal: activity.goal,
              status:
                activity.status === "completed" ? "completed" : lane.status,
              updatedAt: activity.timestamp,
              steps,
              artifacts,
            },
          };
        });
      }),
    [],
  );

  useEffect(
    () =>
      ipc.events.marta.onTaskUpdate(() => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.marta.tasks(),
        });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.marta.worldState(),
        });
      }),
    [queryClient],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      const cutoff = Date.now() - COMPLETED_LINGER_MS;
      setFlowLanes((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(
            ([, lane]) =>
              lane.status !== "completed" || lane.updatedAt >= cutoff,
          ),
        ),
      );
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const lanes = useMemo(
    () => Object.values(flowLanes).sort((a, b) => b.updatedAt - a.updatedAt),
    [flowLanes],
  );
  const visibleRunning = useMemo(() => {
    const projectedFlowIds = new Set(lanes.map((lane) => lane.flowId));
    return running.filter(
      (work) =>
        work.kind !== "claude" &&
        work.kind !== "local" &&
        (work.kind !== "flow" || !projectedFlowIds.has(work.id)),
    );
  }, [lanes, running]);

  const hasContent =
    tasks.length > 0 ||
    lanes.length > 0 ||
    visibleRunning.length > 0 ||
    fluidSurfaces.length > 0 ||
    demoted;

  if (
    running.length === 0 &&
    lanes.length === 0 &&
    tasks.length === 0 &&
    fluidSurfaces.length === 0 &&
    !demoted
  )
    return null;

  const focusTask = (task: MartaTask) => {
    setFocusedTaskId(task.id);
    if (task.appId !== undefined) setSelectedAppId(task.appId);
    focusSurface({
      surfaceId: "build.workspace",
      params: {
        taskId: task.id,
        ...(task.appId !== undefined ? { appId: task.appId } : {}),
      },
    });
  };

  const openTaskInstrument = (task: MartaTask, instrument: TaskInstrument) => {
    setFocusedTaskId(task.id);
    if (task.appId !== undefined) setSelectedAppId(task.appId);
    setPreviewMode(
      instrument === "files"
        ? "code"
        : instrument === "tests"
          ? "problems"
          : instrument,
    );
    setPreviewOpen(true);
    focusSurface({
      surfaceId: "build.workspace",
      params: {
        taskId: task.id,
        ...(task.appId !== undefined ? { appId: task.appId } : {}),
      },
    });
  };

  const makeTaskLarger = (task: MartaTask) => {
    setFocusedTaskId(task.id);
    setCollapsed(false);
    setEmphasis((previous) => ({
      ...previous,
      [task.id]: previous[task.id] === "large" ? "normal" : "large",
    }));
  };

  if (collapsed && hasContent) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="pointer-events-auto z-20 m-3 ml-0 flex w-10 shrink-0 flex-col items-center gap-2 rounded-[16px] border border-white/[0.1] bg-[color-mix(in_srgb,var(--cosmos-bg)_78%,transparent)] py-3 text-primary shadow-[0_18px_55px_rgba(0,0,0,0.38)] backdrop-blur-2xl transition-colors hover:bg-white/[0.07] max-[980px]:m-0 max-[980px]:mb-2 max-[980px]:ml-3 max-[980px]:h-9 max-[980px]:w-auto max-[980px]:flex-row max-[980px]:px-3 max-[980px]:py-0"
        aria-label="Show live task deck"
      >
        <LayoutGrid className="h-4 w-4" />
        <span className="[writing-mode:vertical-rl] text-[9px] font-semibold uppercase tracking-[0.14em] max-[980px]:[writing-mode:horizontal-tb]">
          {tasks.filter((task) => task.status === "running").length} live
        </span>
      </button>
    );
  }

  if (hasContent) {
    return (
      <TaskDeck
        tasks={tasks}
        focusedTaskId={focusedTaskId}
        emphasis={emphasis}
        fluidSurfaces={fluidSurfaces}
        lanes={lanes}
        running={visibleRunning}
        demoted={demoted}
        model={model}
        hardware={hardware}
        residency={residency}
        live={live}
        inference={inference}
        now={now}
        onCollapse={() => setCollapsed(true)}
        onResetLayout={() => setEmphasis({})}
        onFocusTask={focusTask}
        onResizeTask={makeTaskLarger}
        onOpenTaskInstrument={openTaskInstrument}
        onDismissFluidSurface={(surface) => dismissFluidSurface(surface)}
      />
    );
  }

  return (
    <aside
      aria-label="Running work"
      className={cn(
        "pointer-events-auto z-20 m-3 ml-0 flex w-[340px] shrink-0 flex-col gap-2 overflow-y-auto p-2.5",
        radius.md,
        material.rim,
        material.blur,
        "bg-[color-mix(in_srgb,var(--cosmos-bg)_74%,transparent)]",
      )}
    >
      {tasks.length > 0 && (
        <div className="flex items-center justify-between px-1 pb-0.5">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/65">
            <CircleDotDashed className="h-3.5 w-3.5 text-primary/75" />
            Agent tasks
          </span>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[9px] text-primary">
            {tasks.filter((task) => task.status === "running").length} live
          </span>
        </div>
      )}
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          focused={task.id === focusedTaskId}
          onFocus={() => focusTask(task)}
        />
      ))}
      {lanes.length > 0 && (
        <div className="flex items-center justify-between px-1 pb-0.5">
          <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-foreground/65">
            <Workflow className="h-3.5 w-3.5 text-primary/75" />
            Live orchestration
          </span>
          {lanes.filter((lane) => lane.status === "running").length > 1 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[9px] text-primary">
              {lanes.filter((lane) => lane.status === "running").length}{" "}
              parallel
            </span>
          )}
        </div>
      )}
      {demoted && (
        <Row
          tone="warning"
          label="Marta is on CPU"
          detail="The GPU is busy, so she is slower than usual."
        />
      )}
      {lanes.map((lane) => (
        <FlowLaneCard key={lane.flowId} lane={lane} />
      ))}
      {visibleRunning.map((work) => (
        <Row
          key={`${work.kind}:${work.id}`}
          tone={work.awaitingUser ? "warning" : "neutral"}
          label={work.label}
          detail={
            work.awaitingUser
              ? "Waiting for you"
              : work.progress !== undefined
                ? `${work.kind} · ${work.progress}%`
                : work.kind
          }
          progress={work.progress}
          spinning={!work.awaitingUser}
        />
      ))}
    </aside>
  );
}

function TaskCard({
  task,
  focused,
  onFocus,
}: {
  task: MartaTask;
  focused: boolean;
  onFocus: () => void;
}) {
  const active = task.status === "queued" || task.status === "running";
  const failed = task.status === "failed";
  const waiting = task.status === "waiting";
  const tokenCount = (task.inputTokens ?? 0) + (task.outputTokens ?? 0);

  return (
    <button
      type="button"
      onClick={onFocus}
      className={cn(
        "group rounded-[14px] border p-3 text-left transition-all",
        focused
          ? "border-primary/40 bg-primary/[0.09] shadow-[0_0_28px_rgba(139,92,246,0.12)]"
          : "border-white/[0.08] bg-white/[0.035] hover:border-white/[0.16] hover:bg-white/[0.06]",
      )}
      aria-label={`Focus task ${task.title}`}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[9px]",
            failed
              ? "bg-[color-mix(in_srgb,var(--cosmos-red)_14%,transparent)] text-[var(--cosmos-red)]"
              : waiting
                ? "bg-[color-mix(in_srgb,var(--cosmos-amber)_14%,transparent)] text-[var(--cosmos-amber)]"
                : "bg-primary/12 text-primary",
          )}
        >
          {active ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : failed ? (
            <XCircle className="h-3.5 w-3.5" />
          ) : waiting ? (
            <CircleAlert className="h-3.5 w-3.5" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[12px] font-medium leading-[1.35] text-foreground">
            {task.title}
          </span>
          <span className="mt-0.5 block truncate text-[10px] text-foreground/55">
            {task.phase ?? task.status}
          </span>
        </span>
        <Maximize2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-45 transition-opacity group-hover:opacity-100" />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[8px] uppercase tracking-[0.06em] text-muted-foreground">
        <span className="rounded-full bg-white/[0.055] px-1.5 py-0.5">
          {task.workerLabel}
        </span>
        {task.model && (
          <span className="max-w-[132px] truncate rounded-full bg-white/[0.055] px-1.5 py-0.5 normal-case">
            {task.model}
          </span>
        )}
        {task.effort && (
          <span className="rounded-full bg-white/[0.055] px-1.5 py-0.5">
            {task.effort}
          </span>
        )}
      </div>

      {(task.activeTool || task.completedSteps > 0 || tokenCount > 0) && (
        <div className="mt-2 grid grid-cols-3 gap-1 border-t border-white/[0.06] pt-2 text-center">
          <TaskMetric label="Tool" value={task.activeTool ?? "idle"} />
          <TaskMetric label="Steps" value={String(task.completedSteps)} />
          <TaskMetric
            label={task.costUsd !== undefined ? "Cost" : "Tokens"}
            value={
              task.costUsd !== undefined
                ? `$${task.costUsd.toFixed(3)}`
                : tokenCount > 0
                  ? tokenCount.toLocaleString()
                  : "—"
            }
          />
        </div>
      )}
    </button>
  );
}

function TaskMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-0">
      <span className="block truncate font-mono text-[9px] text-foreground/75">
        {value}
      </span>
      <span className="block text-[7px] uppercase tracking-[0.08em] text-muted-foreground/65">
        {label}
      </span>
    </span>
  );
}

function FlowLaneCard({ lane }: { lane: FlowLane }) {
  const steps = Object.values(lane.steps);
  const completed = steps.filter((step) => step.status === "success").length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const percent =
    steps.length > 0
      ? Math.round(
          (steps.filter((step) =>
            ["success", "failed", "skipped"].includes(step.status),
          ).length /
            steps.length) *
            100,
        )
      : lane.status === "completed"
        ? 100
        : 4;

  return (
    <section className="rounded-[12px] border border-white/[0.08] bg-white/[0.035] p-2.5 shadow-[inset_0_1px_rgba(255,255,255,0.04)]">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          {lane.status === "completed" ? (
            failed > 0 ? (
              <CircleAlert className="h-3.5 w-3.5 text-[var(--cosmos-amber)]" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[12px] font-medium leading-[1.35] text-foreground">
            {lane.goal}
          </span>
          <span className="mt-0.5 block font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
            {failed > 0 ? `${failed} need attention · ` : ""}
            {completed}/{steps.length || "…"} steps
          </span>
        </span>
      </div>

      <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            failed > 0 ? "bg-[var(--cosmos-amber)]" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>

      {steps.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {steps.slice(-5).map((step) => (
            <div key={step.stepId} className="flex items-center gap-1.5">
              {step.status === "running" ? (
                <CircleDotDashed className="h-3 w-3 shrink-0 animate-pulse text-primary" />
              ) : step.status === "success" ? (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-[var(--cosmos-green)]" />
              ) : step.status === "failed" ? (
                <XCircle className="h-3 w-3 shrink-0 text-[var(--cosmos-red)]" />
              ) : (
                <CircleAlert className="h-3 w-3 shrink-0 text-[var(--cosmos-amber)]" />
              )}
              <span className="min-w-0 flex-1 truncate text-[10px] text-foreground/75">
                {step.label}
              </span>
              {step.capability && (
                <span className="shrink-0 font-mono text-[8px] text-muted-foreground/70">
                  {step.capability.replace(/_/g, " ")}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {lane.artifacts.length > 0 && (
        <div className="mt-2 border-t border-white/[0.06] pt-1.5">
          {lane.artifacts.map((event) => (
            <div
              key={event.artifact?.id}
              title={event.artifact?.uri}
              className="flex items-center gap-1.5 py-0.5 text-[9px] text-muted-foreground"
            >
              <PackageCheck className="h-3 w-3 shrink-0 text-primary/70" />
              <span className="truncate">{event.label}</span>
              <span className="ml-auto shrink-0 uppercase text-foreground/35">
                {event.artifact?.kind}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Row({
  label,
  detail,
  tone,
  progress,
  spinning,
}: {
  label: string;
  detail: string;
  tone: "neutral" | "warning";
  progress?: number;
  spinning?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-[3px] shrink-0">
        {tone === "warning" ? (
          <CircleAlert className="h-3.5 w-3.5 text-[var(--cosmos-amber)]" />
        ) : spinning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary/70" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium text-foreground">
          {label}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {detail}
        </span>
        {progress !== undefined && (
          <span className="mt-1 block h-[3px] overflow-hidden rounded-full bg-white/10">
            <span
              className="block h-full rounded-full bg-primary transition-[width] duration-500"
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </span>
        )}
      </span>
    </div>
  );
}
