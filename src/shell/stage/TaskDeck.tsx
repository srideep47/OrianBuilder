import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  CircleDotDashed,
  Clock3,
  Code2,
  Cpu,
  Eye,
  FileCode2,
  FlaskConical,
  Gauge,
  LayoutGrid,
  Loader2,
  Maximize2,
  MemoryStick,
  MonitorPlay,
  PackageCheck,
  PanelRightClose,
  Search,
  SquareTerminal,
  TestTube2,
  TimerReset,
  Workflow,
  X,
  XCircle,
} from "lucide-react";

import { material, radius } from "@/components/liquid";
import {
  ipc,
  type FlowActivity,
  type HardwareProfile,
  type InferenceTelemetry,
  type LiveTelemetrySample,
  type MartaModelStatus,
  type MartaResidency,
  type MartaTask,
  type MartaWorldState,
} from "@/ipc/types";
import { cn } from "@/lib/utils";
import {
  columnsForWidth,
  focusWeightFor,
  solveStageLayout,
  taskPriority,
} from "./layout_solver";
import {
  AcceptanceBadge,
  TaskFilesInstrument,
  TaskPreviewInstrument,
  TaskProblemsInstrument,
  TaskResearchInstrument,
  TaskTerminalInstrument,
  TaskTestsInstrument,
} from "./TaskInstruments";
import type { FluidSurfaceRef, TaskSurfaceEmphasis } from "./workspace_state";

export interface TaskDeckFlowLane {
  flowId: string;
  goal: string;
  status: "running" | "completed";
  updatedAt: number;
  steps: Record<string, FlowActivity>;
  artifacts: FlowActivity[];
}

type RunningWork = MartaWorldState["running"][number];
export type TaskInstrument =
  | "preview"
  | "files"
  | "terminal"
  | "problems"
  | "tests";

interface TaskDeckProps {
  tasks: MartaTask[];
  focusedTaskId: string | null;
  emphasis: Record<string, TaskSurfaceEmphasis>;
  fluidSurfaces: FluidSurfaceRef[];
  lanes: TaskDeckFlowLane[];
  running: RunningWork[];
  demoted: boolean;
  model: MartaModelStatus;
  hardware?: HardwareProfile;
  residency?: MartaResidency;
  /** Sampled machine load; undefined until the first probe returns. */
  live?: LiveTelemetrySample;
  inference?: InferenceTelemetry;
  now: number;
  onCollapse: () => void;
  onResetLayout: () => void;
  onFocusTask: (task: MartaTask) => void;
  onResizeTask: (task: MartaTask) => void;
  onOpenTaskInstrument: (task: MartaTask, instrument: TaskInstrument) => void;
  onDismissFluidSurface: (surface: FluidSurfaceRef) => void;
}

/**
 * A fluid projection of all work Marta is supervising.
 *
 * CSS grid owns placement, so adding a second or fifth task never requires a
 * new layout branch. Intent is represented only as visual weight (`normal`,
 * `large`, `focus`), which is what lets voice commands resize one tile while
 * every other tile naturally occupies the remaining space.
 */
export function TaskDeck({
  tasks,
  focusedTaskId,
  emphasis,
  fluidSurfaces,
  lanes,
  running,
  demoted,
  model,
  hardware,
  residency,
  live,
  inference,
  now,
  onCollapse,
  onResetLayout,
  onFocusTask,
  onResizeTask,
  onOpenTaskInstrument,
  onDismissFluidSurface,
}: TaskDeckProps) {
  const tileCount =
    tasks.length + fluidSurfaces.length + lanes.length + running.length;
  const liveCount = tasks.filter((task) => task.status === "running").length;

  // The deck measures itself so the solver works in columns rather than in
  // guessed viewport breakpoints: the same deck is a different width beside a
  // maximised workspace than beside an empty Stage.
  const gridRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(2);
  useEffect(() => {
    const element = gridRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setColumns(columnsForWidth(entry.contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const solved = useMemo(
    () =>
      solveStageLayout(
        tasks.map((task) => ({
          key: task.id,
          taskId: task.id,
          kind: "task" as const,
          priority: taskPriority(task),
          focusWeight: focusWeightFor(emphasis[task.id] ?? "normal"),
          minColumns: 1,
          preferredColumns: 1,
          // A task needing attention is never collapsed away: running out of
          // room must not be the reason a failure is invisible.
          collapsible: !(task.requiresAttention || task.status === "failed"),
        })),
        { columns },
      ),
    [columns, emphasis, tasks],
  );
  const tileByTaskId = useMemo(
    () => new Map(solved.tiles.map((tile) => [tile.taskId, tile])),
    [solved.tiles],
  );
  const visibleTasks = useMemo(
    () =>
      solved.tiles
        .map((tile) => tasks.find((task) => task.id === tile.taskId))
        .filter((task): task is MartaTask => task !== undefined),
    [solved.tiles, tasks],
  );

  return (
    <aside
      aria-label="Live task and instrument deck"
      data-testid="stage-task-deck"
      data-tile-count={tileCount}
      className={cn(
        "pointer-events-auto z-20 m-3 ml-0 flex shrink-0 flex-col overflow-hidden",
        tileCount > 1
          ? "w-[clamp(420px,48vw,780px)]"
          : "w-[clamp(340px,31vw,460px)]",
        "max-[1180px]:w-[clamp(360px,42vw,540px)]",
        "max-[980px]:m-0 max-[980px]:mx-3 max-[980px]:mb-2 max-[980px]:max-h-[38vh] max-[980px]:w-auto",
        radius.md,
        material.rim,
        material.blurThick,
        "bg-[color-mix(in_srgb,var(--cosmos-bg)_74%,transparent)]",
        "shadow-[0_22px_80px_rgba(0,0,0,0.34)]",
      )}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/[0.07] px-3">
        <LayoutGrid className="h-3.5 w-3.5 text-primary" />
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/70">
          Command deck
        </span>
        <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[9px] text-primary">
          {liveCount} live
        </span>
        <span className="hidden truncate text-[10px] text-muted-foreground min-[1280px]:inline">
          Surfaces reflow automatically
        </span>
        <button
          type="button"
          onClick={onResetLayout}
          className="ml-auto rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          aria-label="Tile all task surfaces evenly"
          title="Tile all task surfaces evenly"
        >
          <TimerReset className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onCollapse}
          className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          aria-label="Hide live task deck"
          title="Hide live task deck"
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        <div
          ref={gridRef}
          data-columns={solved.columns}
          className="grid auto-rows-min gap-2.5"
          style={{
            gridTemplateColumns: `repeat(${solved.columns}, minmax(0, 1fr))`,
          }}
        >
          {visibleTasks.map((task, index) => (
            <TaskSurface
              key={task.id}
              task={task}
              // Numbered by *presentation* order, so "make task two larger"
              // names the tile the user is pointing at.
              number={index + 1}
              now={now}
              focused={task.id === focusedTaskId}
              emphasis={emphasis[task.id] ?? "normal"}
              span={tileByTaskId.get(task.id)}
              onFocus={() => onFocusTask(task)}
              onResize={() => onResizeTask(task)}
              onInstrument={(instrument) =>
                onOpenTaskInstrument(task, instrument)
              }
            />
          ))}

          {solved.collapsed.length > 0 && (
            // Counted, not hidden. A deck that silently drops work reads as
            // "that's everything", which is the one thing it must never imply.
            <button
              type="button"
              data-testid="stage-collapsed-tasks"
              onClick={onResetLayout}
              style={{ gridColumn: `span ${solved.columns}` }}
              className="flex items-center gap-2 rounded-[12px] border border-dashed border-white/[0.12] px-2.5 py-2 text-left text-[10px] text-muted-foreground transition-colors hover:border-white/[0.22] hover:text-foreground"
            >
              <LayoutGrid className="h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {solved.collapsed.length} more task
                {solved.collapsed.length === 1 ? "" : "s"} running:{" "}
                {solved.collapsed
                  .map(
                    (item) =>
                      tasks.find((task) => task.id === item.taskId)?.title,
                  )
                  .filter(Boolean)
                  .join(", ")}
              </span>
            </button>
          )}

          {fluidSurfaces.map((surface) => (
            <FluidSurfaceCard
              key={`${surface.id}:${surface.taskId ?? "global"}`}
              surface={surface}
              task={tasks.find((task) => task.id === surface.taskId)}
              hardware={hardware}
              residency={residency}
              live={live}
              inference={inference}
              model={model}
              now={now}
              onOpenTaskInstrument={onOpenTaskInstrument}
              onDismiss={() => onDismissFluidSurface(surface)}
            />
          ))}

          {demoted && (
            <InstrumentShell
              icon={<Cpu className="h-3.5 w-3.5" />}
              title="Marta residency"
              eyebrow="Resource governor"
            >
              <StatusRow
                tone="warning"
                label="Marta is on CPU"
                detail="The GPU is busy, so she is slower than usual."
              />
            </InstrumentShell>
          )}

          {lanes.map((lane) => (
            <FlowLaneSurface key={lane.flowId} lane={lane} />
          ))}

          {running.map((work) => (
            <InstrumentShell
              key={`${work.kind}:${work.id}`}
              icon={<Activity className="h-3.5 w-3.5" />}
              title={work.label}
              eyebrow={work.kind}
            >
              <StatusRow
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
            </InstrumentShell>
          ))}
        </div>
      </div>
    </aside>
  );
}

function TaskSurface({
  task,
  number,
  now,
  focused,
  emphasis,
  span,
  onFocus,
  onResize,
  onInstrument,
}: {
  task: MartaTask;
  number: number;
  now: number;
  focused: boolean;
  emphasis: TaskSurfaceEmphasis;
  /** Solved placement; absent only if the solver and the list disagree. */
  span?: { columns: number; rows: number };
  onFocus: () => void;
  onResize: () => void;
  onInstrument: (instrument: TaskInstrument) => void;
}) {
  const active = task.status === "queued" || task.status === "running";
  const failed = task.status === "failed";
  const waiting = task.status === "waiting";
  const tokenCount = (task.inputTokens ?? 0) + (task.outputTokens ?? 0);
  const elapsed = formatElapsed((task.completedAt ?? now) - task.createdAt);

  return (
    <section
      data-testid="stage-task-surface"
      data-task-id={task.id}
      data-emphasis={emphasis}
      data-columns={span?.columns ?? 1}
      // Spans come from the solver rather than from emphasis classes, so an
      // emphasised tile takes columns *from* its siblings instead of merely
      // growing and pushing them below the fold.
      style={{
        gridColumn: `span ${span?.columns ?? 1}`,
        gridRow: `span ${span?.rows ?? 1}`,
      }}
      className={cn(
        "group min-w-0 rounded-[15px] border p-3 text-left transition-[background-color,border-color] duration-300",
        emphasis === "large" && "min-h-[290px]",
        emphasis === "focus" && "min-h-[360px]",
        focused
          ? "border-primary/40 bg-primary/[0.09] shadow-[0_0_28px_rgba(139,92,246,0.12)]"
          : "border-white/[0.08] bg-white/[0.035] hover:border-white/[0.16] hover:bg-white/[0.06]",
      )}
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
          <span className="mb-0.5 block font-mono text-[8px] uppercase tracking-[0.12em] text-primary/65">
            {task.workerLabel} task {number}
          </span>
          <span className="line-clamp-2 text-[12px] font-medium leading-[1.35] text-foreground">
            {task.title}
          </span>
          <span className="mt-0.5 block truncate text-[10px] text-foreground/55">
            {task.phase ?? task.status}
          </span>
        </span>
        <button
          type="button"
          onClick={onResize}
          aria-label={
            emphasis === "large"
              ? `Make ${task.title} smaller`
              : `Make ${task.title} larger`
          }
          title={emphasis === "large" ? "Return to tile size" : "Make larger"}
          className="rounded-full p-1 text-muted-foreground opacity-65 transition-all hover:bg-white/[0.08] hover:text-foreground group-hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[8px] uppercase tracking-[0.06em] text-muted-foreground">
        <span className="rounded-full bg-white/[0.055] px-1.5 py-0.5">
          {task.kind}
        </span>
        {task.effort && (
          <span className="rounded-full bg-white/[0.055] px-1.5 py-0.5">
            {task.effort}
          </span>
        )}
        <span className="rounded-full bg-white/[0.055] px-1.5 py-0.5">
          {task.status}
        </span>
        {/* `succeeded` alone is ambiguous — it could be a worker's word. This
            says who decided, which is the distinction the acceptance contract
            exists to make visible. */}
        <AcceptanceBadge task={task} />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-white/[0.06] bg-white/[0.06] min-[1320px]:grid-cols-5">
        <TaskMetric
          icon={<FileCode2 className="h-3 w-3" />}
          label="Active file"
          value={task.activeFile ?? "Waiting for file activity"}
        />
        <TaskMetric
          icon={<Gauge className="h-3 w-3" />}
          label="Current tool"
          value={
            task.activeTool ?? (active ? (task.phase ?? "Starting") : "Idle")
          }
        />
        <TaskMetric
          icon={<Cpu className="h-3 w-3" />}
          label="Model"
          value={task.model ?? "Runtime default"}
        />
        <TaskMetric
          icon={<Activity className="h-3 w-3" />}
          label="Tokens"
          value={tokenCount > 0 ? tokenCount.toLocaleString() : "Not reported"}
        />
        <TaskMetric
          icon={<Clock3 className="h-3 w-3" />}
          label="Elapsed"
          value={elapsed}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-1" aria-label="Task instruments">
        <TaskInstrumentButton
          icon={<Eye />}
          label={task.previewUrl ? "Preview · ready" : "Preview"}
          onClick={() => onInstrument("preview")}
        />
        <TaskInstrumentButton
          icon={<Code2 />}
          label="Files"
          onClick={() => onInstrument("files")}
        />
        <TaskInstrumentButton
          icon={<SquareTerminal />}
          label={
            task.terminalTail?.length
              ? `Terminal · ${task.terminalTail.at(-1)}`
              : "Terminal"
          }
          onClick={() => onInstrument("terminal")}
        />
        <TaskInstrumentButton
          icon={<CircleAlert />}
          label="Problems"
          onClick={() => onInstrument("problems")}
        />
        <TaskInstrumentButton
          icon={<TestTube2 />}
          label={task.testSummary ? `Tests · ${task.testSummary}` : "Tests"}
          onClick={() => onInstrument("tests")}
        />
        <button
          type="button"
          onClick={onFocus}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-full bg-primary/12 px-2 text-[9px] font-medium text-primary transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
          aria-label={`Open workspace for ${task.title}`}
        >
          Workspace
          <Maximize2 className="h-3 w-3" />
        </button>
      </div>

      {task.error && (
        <p className="mt-2 line-clamp-2 rounded-[8px] bg-[var(--cosmos-red)]/8 px-2 py-1.5 font-mono text-[9px] leading-[1.4] text-[var(--cosmos-red)]">
          {task.error}
        </p>
      )}
    </section>
  );
}

function TaskMetric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <span className="min-w-0 bg-[color-mix(in_srgb,var(--cosmos-deep)_72%,transparent)] px-2 py-1.5">
      <span className="flex items-center gap-1 text-[7px] uppercase tracking-[0.08em] text-muted-foreground/70">
        {icon}
        {label}
      </span>
      <span
        className="mt-0.5 block truncate font-mono text-[9px] text-foreground/78"
        title={value}
      >
        {value}
      </span>
    </span>
  );
}

function TaskInstrumentButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactElement<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 min-w-0 items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.035] px-2 text-[9px] text-foreground/62 transition-colors hover:border-white/[0.14] hover:bg-white/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
      title={label}
    >
      {icon}
      <span className="max-w-24 truncate">{label}</span>
    </button>
  );
}

const FLUID_META: Record<
  FluidSurfaceRef["id"],
  { title: string; eyebrow: string; icon: ReactNode }
> = {
  preview: {
    title: "Live preview",
    eyebrow: "Project instrument",
    icon: <MonitorPlay className="h-3.5 w-3.5" />,
  },
  problems: {
    title: "Problems",
    eyebrow: "Project instrument",
    icon: <CircleAlert className="h-3.5 w-3.5" />,
  },
  files: {
    title: "Active files",
    eyebrow: "Project instrument",
    icon: <FileCode2 className="h-3.5 w-3.5" />,
  },
  terminal: {
    title: "Terminal",
    eyebrow: "Project instrument",
    icon: <SquareTerminal className="h-3.5 w-3.5" />,
  },
  tests: {
    title: "Tests",
    eyebrow: "Verification",
    icon: <FlaskConical className="h-3.5 w-3.5" />,
  },
  timeline: {
    title: "Task timeline",
    eyebrow: "Supervision",
    icon: <Clock3 className="h-3.5 w-3.5" />,
  },
  research: {
    title: "Research",
    eyebrow: "Evidence stream",
    icon: <Search className="h-3.5 w-3.5" />,
  },
  gpu: {
    title: "GPU",
    eyebrow: "Machine telemetry",
    icon: <Gauge className="h-3.5 w-3.5" />,
  },
  pc: {
    title: "PC",
    eyebrow: "Machine telemetry",
    icon: <Cpu className="h-3.5 w-3.5" />,
  },
  models: {
    title: "Model runtime",
    eyebrow: "Inference telemetry",
    icon: <MemoryStick className="h-3.5 w-3.5" />,
  },
};

function FluidSurfaceCard({
  surface,
  task,
  hardware,
  residency,
  live,
  inference,
  model,
  now,
  onOpenTaskInstrument,
  onDismiss,
}: {
  surface: FluidSurfaceRef;
  task?: MartaTask;
  hardware?: HardwareProfile;
  residency?: MartaResidency;
  live?: LiveTelemetrySample;
  inference?: InferenceTelemetry;
  model: MartaModelStatus;
  now: number;
  onOpenTaskInstrument: (task: MartaTask, instrument: TaskInstrument) => void;
  onDismiss: () => void;
}) {
  const meta = FLUID_META[surface.id];
  // Project instruments render their real content inline. The button to the full
  // workspace stays, because a 245px tile is a reading surface, not an editor.
  const projectInstrument = [
    "preview",
    "problems",
    "files",
    "terminal",
    "tests",
  ].includes(surface.id);

  return (
    <InstrumentShell
      icon={meta.icon}
      title={meta.title}
      eyebrow={task ? task.title : meta.eyebrow}
      wide={surface.id === "preview"}
      action={
        <>
          {projectInstrument && task && (
            <button
              type="button"
              onClick={() =>
                onOpenTaskInstrument(task, surface.id as TaskInstrument)
              }
              aria-label={`Open ${meta.title} in the workspace`}
              title={`Open ${meta.title} in the workspace`}
              className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
            >
              <Maximize2 className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
            aria-label={`Close ${meta.title} surface`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      }
    >
      {surface.id === "gpu" ? (
        <GpuTelemetry hardware={hardware} residency={residency} live={live} />
      ) : surface.id === "pc" ? (
        <PcTelemetry hardware={hardware} live={live} />
      ) : surface.id === "models" ? (
        <ModelTelemetry
          model={model}
          residency={residency}
          inference={inference}
        />
      ) : surface.id === "timeline" ? (
        <TaskTimeline task={task} now={now} />
      ) : surface.id === "research" ? (
        <TaskResearchInstrument task={task} />
      ) : surface.id === "preview" ? (
        <TaskPreviewInstrument task={task} />
      ) : surface.id === "terminal" ? (
        <TaskTerminalInstrument task={task} />
      ) : surface.id === "tests" ? (
        <TaskTestsInstrument task={task} />
      ) : surface.id === "problems" ? (
        <TaskProblemsInstrument task={task} />
      ) : surface.id === "files" ? (
        <TaskFilesInstrument task={task} />
      ) : (
        <EmptyInstrument
          label={`${meta.title} is ready to attach to a task.`}
          detail="Focus a task, then ask Marta to show this instrument again."
        />
      )}
    </InstrumentShell>
  );
}

/**
 * A sampled reading, with its own bar.
 *
 * A percentage next to a bar is redundant on paper and not in practice: the bar
 * is what you read at a glance while work is running, and the number is what you
 * read when you want to know whether 90% is 90.4 or 89.6.
 */
function TelemetryGauge({
  label,
  percent,
  detail,
  tone = "primary",
}: {
  label: string;
  percent: number | null;
  detail: string;
  tone?: "primary" | "warm";
}) {
  return (
    <span className="col-span-2 min-w-0 rounded-[9px] border border-white/[0.06] bg-white/[0.025] px-2 py-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[7px] uppercase tracking-[0.1em] text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-[9px] text-foreground/80">
          {percent === null ? "sampling…" : `${percent.toFixed(0)}%`}
        </span>
      </span>
      <span
        className="mt-1 block h-[3px] overflow-hidden rounded-full bg-white/[0.08]"
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-500",
            tone === "warm"
              ? "bg-[var(--cosmos-amber)]"
              : percent !== null && percent > 92
                ? "bg-[var(--cosmos-red)]"
                : "bg-primary",
          )}
          style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
        />
      </span>
      <span
        className="mt-1 block truncate font-mono text-[8px] text-muted-foreground"
        title={detail}
      >
        {detail}
      </span>
    </span>
  );
}

function gigabytes(mb: number | null | undefined): string {
  return mb === null || mb === undefined ? "—" : `${(mb / 1024).toFixed(1)} GB`;
}

function GpuTelemetry({
  hardware,
  residency,
  live,
}: {
  hardware?: HardwareProfile;
  residency?: MartaResidency;
  live?: LiveTelemetrySample;
}) {
  const sampled = live?.gpus[0];
  const gpu = hardware?.primaryGpu;
  const vramPercent =
    sampled?.memoryUsedMb != null && sampled.memoryTotalMb
      ? (sampled.memoryUsedMb / sampled.memoryTotalMb) * 100
      : null;

  return (
    <div className="grid grid-cols-2 gap-1.5">
      <TelemetryValue
        label="Adapter"
        value={sampled?.name ?? gpu?.model ?? "Detecting…"}
        wide
      />
      <TelemetryGauge
        label="Utilisation"
        percent={sampled?.utilizationPercent ?? null}
        detail={
          sampled?.clockMhz != null
            ? `${sampled.clockMhz.toFixed(0)} MHz SM clock`
            : (live?.gpuUnavailableReason ?? "Waiting for a sample")
        }
      />
      <TelemetryGauge
        label="VRAM"
        percent={vramPercent}
        detail={
          sampled
            ? `${gigabytes(sampled.memoryUsedMb)} of ${gigabytes(sampled.memoryTotalMb ?? gpu?.vramMb)}`
            : gigabytes(gpu?.vramMb)
        }
      />
      <TelemetryValue
        label="Temp"
        value={
          sampled?.temperatureC != null ? `${sampled.temperatureC}°C` : "—"
        }
      />
      <TelemetryValue
        label="Power"
        value={
          sampled?.powerWatts != null
            ? `${sampled.powerWatts.toFixed(0)} W${
                sampled.powerLimitWatts != null
                  ? ` / ${sampled.powerLimitWatts.toFixed(0)}`
                  : ""
              }`
            : "—"
        }
      />
      <TelemetryValue
        label="Backend"
        value={hardware?.bestLlmBackend.toUpperCase() ?? "—"}
      />
      <TelemetryValue
        label="Marta"
        value={residency?.placement?.toUpperCase() ?? "Paused"}
      />
      {live?.gpuUnavailableReason && (
        <p className="col-span-2 text-[9px] leading-[1.4] text-muted-foreground">
          {live.gpuUnavailableReason}
        </p>
      )}
    </div>
  );
}

function PcTelemetry({
  hardware,
  live,
}: {
  hardware?: HardwareProfile;
  live?: LiveTelemetrySample;
}) {
  const busiestCore = live?.cpu.perCore.length
    ? Math.max(...live.cpu.perCore)
    : null;

  return (
    <div className="grid grid-cols-2 gap-1.5">
      <TelemetryValue
        label="CPU"
        value={hardware?.cpu.model ?? "Detecting…"}
        wide
      />
      <TelemetryGauge
        label="CPU load"
        percent={live?.cpu.percent ?? null}
        detail={
          busiestCore !== null
            ? `${live?.cpu.cores ?? 0} threads · busiest ${busiestCore.toFixed(0)}%`
            : "First sample establishes the baseline"
        }
      />
      <TelemetryGauge
        label="Memory"
        percent={live?.memory.percent ?? null}
        detail={
          live
            ? `${gigabytes(live.memory.usedMb)} of ${gigabytes(live.memory.totalMb)} · Orion ${live.memory.processRssMb} MB`
            : gigabytes(hardware?.totalRamMb)
        }
        tone="warm"
      />
      <TelemetryValue
        label="Cores"
        value={
          hardware
            ? `${hardware.cpu.cores} / ${hardware.cpu.logicalCores} threads`
            : "—"
        }
      />
      <TelemetryValue
        label="Load avg"
        value={
          live?.cpu.loadAverage != null
            ? live.cpu.loadAverage.toFixed(2)
            : "n/a on Windows"
        }
      />
      <TelemetryValue label="OS" value={hardware?.os ?? "—"} />
      <TelemetryValue label="Arch" value={hardware?.arch ?? "—"} />
    </div>
  );
}

function ModelTelemetry({
  model,
  residency,
  inference,
}: {
  model: MartaModelStatus;
  residency?: MartaResidency;
  inference?: InferenceTelemetry;
}) {
  const latest = inference?.samples.at(-1);
  return (
    <div className="grid grid-cols-2 gap-1.5">
      <TelemetryValue
        label="Companion"
        value={model.modelId ?? "Not running"}
        wide
      />
      <TelemetryValue
        label="Decode"
        value={
          inference?.lastTokensPerSecond != null
            ? `${inference.lastTokensPerSecond.toFixed(1)} tok/s`
            : "No call yet"
        }
      />
      <TelemetryValue
        label="Average"
        value={
          inference?.averageTokensPerSecond != null
            ? `${inference.averageTokensPerSecond.toFixed(1)} tok/s`
            : "—"
        }
      />
      <TelemetryValue
        label="First token"
        value={
          inference?.lastTimeToFirstTokenMs != null
            ? `${inference.lastTimeToFirstTokenMs} ms`
            : "Not streamed"
        }
      />
      <TelemetryValue
        label="Placement"
        value={model.placement?.toUpperCase() ?? "—"}
      />
      <TelemetryGauge
        label="Context used"
        percent={inference?.lastContextPercent ?? null}
        detail={
          latest
            ? `${(latest.promptTokens + latest.completionTokens).toLocaleString()} of ${latest.contextSize?.toLocaleString() ?? "?"} tokens`
            : "Waiting for the next turn"
        }
      />
      <TelemetryValue label="Tier" value={residency?.plan?.label ?? "—"} />
      <TelemetryValue
        label="Migrations"
        value={String(residency?.recentDemotions ?? 0)}
      />
    </div>
  );
}

function TaskTimeline({ task, now }: { task?: MartaTask; now: number }) {
  const { data } = useQuery({
    queryKey: ["marta", "task-events", task?.id],
    queryFn: () => ipc.marta.listTaskEvents({ taskId: task?.id, limit: 40 }),
    enabled: Boolean(task),
    refetchInterval: task?.status === "running" ? 1_000 : false,
  });
  if (!task) {
    return (
      <EmptyInstrument
        label="No task is selected."
        detail="Say “show Claude task one timeline”."
      />
    );
  }
  const events = data?.events ?? [];
  if (events.length > 0) {
    return (
      <ol
        className="max-h-48 space-y-2 overflow-y-auto pr-1"
        aria-label={`Timeline for ${task.title}`}
      >
        {events.slice(-10).map((event) => (
          <li key={event.eventId} className="flex items-start gap-2">
            <span
              className={cn(
                "mt-1 h-2 w-2 shrink-0 rounded-full",
                event.type === "failed"
                  ? "bg-[var(--cosmos-red)]"
                  : event.type === "succeeded"
                    ? "bg-[var(--cosmos-green)]"
                    : event.type === "blocked"
                      ? "bg-[var(--cosmos-amber)]"
                      : "bg-primary",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 block text-[9px] leading-[1.4] text-foreground/72">
                {event.publicSummary}
              </span>
              <span className="mt-0.5 block font-mono text-[7px] uppercase tracking-[0.08em] text-muted-foreground">
                {event.actor} · {event.type}
              </span>
            </span>
            <span className="shrink-0 font-mono text-[7px] text-muted-foreground">
              {relativeTime(now - event.timestamp)}
            </span>
          </li>
        ))}
      </ol>
    );
  }
  const rows = [
    { label: "Created", value: relativeTime(now - task.createdAt) },
    {
      label: task.phase ?? "Updated",
      value: relativeTime(now - task.updatedAt),
    },
    ...(task.completedAt
      ? [{ label: task.status, value: relativeTime(now - task.completedAt) }]
      : []),
  ];
  return (
    <ol className="space-y-2" aria-label={`Timeline for ${task.title}`}>
      {rows.map((row, index) => (
        <li key={`${row.label}:${index}`} className="flex items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              index === rows.length - 1 ? "bg-primary" : "bg-white/20",
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[10px] text-foreground/72">
            {row.label}
          </span>
          <span className="shrink-0 font-mono text-[8px] text-muted-foreground">
            {row.value}
          </span>
        </li>
      ))}
    </ol>
  );
}

function TelemetryValue({
  label,
  value,
  wide,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <span
      className={cn(
        "min-w-0 rounded-[9px] border border-white/[0.06] bg-white/[0.025] px-2 py-1.5",
        wide && "col-span-2",
      )}
    >
      <span className="block text-[7px] uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
      <span
        className="mt-0.5 block truncate font-mono text-[9px] text-foreground/78"
        title={value}
      >
        {value}
      </span>
    </span>
  );
}

function EmptyInstrument({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="flex min-h-24 flex-col items-center justify-center px-2 text-center">
      <p className="text-[11px] text-foreground/68">{label}</p>
      <p className="mt-1 text-[9px] leading-[1.4] text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

function InstrumentShell({
  icon,
  title,
  eyebrow,
  action,
  wide,
  children,
}: {
  icon: ReactNode;
  title: string;
  eyebrow: string;
  action?: ReactNode;
  /** An embedded live app is unreadable at tile width; it takes the row. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-[14px] border border-white/[0.08] bg-white/[0.035] p-2.5 shadow-[inset_0_1px_rgba(255,255,255,0.04)]",
        wide && "col-span-full",
      )}
    >
      <div className="mb-2.5 flex items-center gap-2 border-b border-white/[0.06] pb-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[9px] bg-primary/10 text-primary">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-medium text-foreground">
            {title}
          </span>
          <span className="block truncate text-[7px] uppercase tracking-[0.11em] text-muted-foreground">
            {eyebrow}
          </span>
        </span>
        {action}
      </div>
      {children}
    </section>
  );
}

function FlowLaneSurface({ lane }: { lane: TaskDeckFlowLane }) {
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
    <InstrumentShell
      icon={<Workflow className="h-3.5 w-3.5" />}
      title={lane.goal}
      eyebrow="Live orchestration"
    >
      <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
        {lane.status === "running" ? (
          <Loader2 className="h-3 w-3 animate-spin text-primary" />
        ) : failed > 0 ? (
          <CircleAlert className="h-3 w-3 text-[var(--cosmos-amber)]" />
        ) : (
          <CheckCircle2 className="h-3 w-3 text-[var(--cosmos-green)]" />
        )}
        {failed > 0 ? `${failed} need attention · ` : ""}
        {completed}/{steps.length || "…"} steps
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
    </InstrumentShell>
  );
}

function StatusRow({
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
        <span className="block truncate text-[11px] font-medium text-foreground">
          {label}
        </span>
        <span className="block truncate text-[10px] text-muted-foreground">
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

function formatElapsed(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function relativeTime(durationMs: number): string {
  const elapsed = formatElapsed(durationMs);
  return durationMs < 1_000 ? "now" : `${elapsed} ago`;
}
