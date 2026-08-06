import { atom } from "jotai";

import type { MartaTask } from "@/ipc/types";
import { focusedTaskIdAtom } from "./task_state";

export const FLUID_SURFACE_IDS = [
  "preview",
  "problems",
  "files",
  "terminal",
  "tests",
  "timeline",
  "research",
  "gpu",
  "pc",
  "models",
] as const;

export type FluidSurfaceId = (typeof FLUID_SURFACE_IDS)[number];

export interface FluidSurfaceRef {
  id: FluidSurfaceId;
  /** A task-scoped surface, such as its timeline or test result. */
  taskId?: string;
}

export type TaskSurfaceEmphasis = "normal" | "large" | "focus";

/**
 * The renderer's live projection of the durable task registry.
 *
 * Main remains the source of truth. This atom only lets the task deck and the
 * natural-language layout controls resolve the exact same visible task names.
 */
export const projectedMartaTasksAtom = atom<MartaTask[]>([]);

/** Per-task visual weight. CSS grid does the placement; this state expresses intent. */
export const taskSurfaceEmphasisAtom = atom<
  Record<string, TaskSurfaceEmphasis>
>({});

/** Small, summonable instruments that share the task deck rather than becoming chrome. */
export const fluidSurfacesAtom = atom<FluidSurfaceRef[]>([]);

export const taskDeckCollapsedAtom = atom(false);

/**
 * Whether the conversation is on screen.
 *
 * Collapsed by default and owned here rather than by `Presence`'s local state,
 * because "show me the conversation" is a layout command like any other and has
 * to be reachable from the same parser.
 */
export const transcriptExpandedAtom = atom(false);

export type StageLayoutCommand =
  | {
      kind: "emphasize-task";
      taskId: string;
      emphasis: TaskSurfaceEmphasis;
    }
  | { kind: "tile-tasks" }
  | { kind: "summon"; surfaces: FluidSurfaceRef[] }
  | { kind: "dismiss"; surfaces: FluidSurfaceId[] }
  | { kind: "show-task-deck" }
  | { kind: "hide-task-deck" }
  | { kind: "show-transcript" }
  | { kind: "hide-transcript" }
  /**
   * Stop, retry or reprioritise a task.
   *
   * Parsed here with the layout language because the user says it in the same
   * breath — "stop task two, give its resources to task one" — but it is not a
   * layout change, so the caller executes it through `marta:control-task`
   * instead of only setting atoms.
   */
  | {
      kind: "control-task";
      taskId: string;
      taskTitle: string;
      action: "stop" | "retry" | "prioritize";
      priority?: number;
    };

export interface StageLayoutCommandResult {
  command: StageLayoutCommand;
  acknowledgement: string;
}

const ORDINALS: ReadonlyArray<ReadonlyArray<string>> = [
  ["1", "one", "first"],
  ["2", "two", "second"],
  ["3", "three", "third"],
  ["4", "four", "fourth"],
  ["5", "five", "fifth"],
  ["6", "six", "sixth"],
];

const SURFACE_ALIASES: ReadonlyArray<{
  id: FluidSurfaceId;
  patterns: ReadonlyArray<RegExp>;
}> = [
  { id: "preview", patterns: [/\bpreview\b/, /\brunning app\b/] },
  { id: "problems", patterns: [/\bproblems?\b/, /\berrors?\b/] },
  { id: "files", patterns: [/\bfiles?\b/, /\bsource(?: code)?\b/] },
  { id: "terminal", patterns: [/\bterminal\b/, /\bconsole\b/, /\bshell\b/] },
  { id: "tests", patterns: [/\btests?\b/, /\btest results?\b/] },
  { id: "timeline", patterns: [/\btimeline\b/, /\btask history\b/] },
  { id: "research", patterns: [/\bresearch\b/, /\bweb findings?\b/] },
  {
    id: "gpu",
    patterns: [/\bgpu\b/, /\bvram\b/, /\bgraphics (?:card|stats?)\b/],
  },
  {
    id: "pc",
    // "PC health" and "CPU load" are the same request as "PC stats"; a narrow
    // alias list makes the feature look broken for a synonym the user picked.
    patterns: [
      /\b(?:pc|system|machine|hardware)\s+(?:stats?|status|health|load|usage|telemetry)\b/,
      /\bcpu (?:load|usage|stats?)\b/,
      /\b(?:ram|memory) (?:usage|load|stats?)\b/,
    ],
  },
  {
    id: "models",
    patterns: [
      /\bmodel (?:stats?|status|telemetry|inference)\b/,
      /\b(?:model )?inference (?:stats?|status|telemetry|speed)\b/,
      /\btokens? per second\b/,
      /\bhow fast (?:are you|is she|is it)\b/,
      /\bcontext (?:used|usage|occupancy)\b/,
    ],
  },
];

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function taskLabel(task: MartaTask): string {
  return task.workerLabel || task.kind;
}

/**
 * Resolve human references such as "Claude task one" deterministically.
 * Running work is ordered before completed work, then oldest-to-newest so the
 * number does not jump every time a status update changes `updatedAt`.
 */
export function resolveTaskReference(
  utterance: string,
  tasks: MartaTask[],
  focusedTaskId?: string | null,
): MartaTask | null {
  const text = normalized(utterance);
  if (tasks.length === 0) return null;

  if (/\b(current|focused|selected) task\b/.test(text) && focusedTaskId) {
    return tasks.find((task) => task.id === focusedTaskId) ?? null;
  }

  const active = (task: MartaTask) =>
    task.status === "queued" ||
    task.status === "running" ||
    task.status === "waiting";
  let candidates = [...tasks].sort(
    (a, b) =>
      Number(active(b)) - Number(active(a)) || a.createdAt - b.createdAt,
  );

  const workerMatchers: ReadonlyArray<[RegExp, (task: MartaTask) => boolean]> =
    [
      [
        /\bclaude\b/,
        (task) => task.kind === "claude" || /claude/i.test(taskLabel(task)),
      ],
      [
        /\b(local|qwen)\b/,
        (task) => task.kind === "local" || /local|qwen/i.test(taskLabel(task)),
      ],
      [/\bmission\b/, (task) => task.kind === "mission"],
      [/\b(flow|workflow)\b/, (task) => task.kind === "flow"],
    ];
  const worker = workerMatchers.find(([pattern]) => pattern.test(text));
  if (worker) candidates = candidates.filter(worker[1]);
  if (candidates.length === 0) return null;

  const ordinal = ORDINALS.findIndex((forms) =>
    forms.some((form) => new RegExp(`\\b(?:task\\s+)?${form}\\b`).test(text)),
  );
  if (ordinal >= 0) return candidates[ordinal] ?? null;

  const scored = candidates
    .map((task) => {
      const haystack = normalized(
        `${task.title} ${task.goal} ${task.projectName ?? ""} ${task.workerLabel}`,
      );
      const meaningful = text
        .split(" ")
        .filter(
          (word) =>
            word.length > 2 &&
            ![
              "make",
              "task",
              "larger",
              "bigger",
              "smaller",
              "focus",
              "maximize",
              "resize",
              "please",
              "show",
            ].includes(word),
        );
      return {
        task,
        score: meaningful.filter((word) => haystack.includes(word)).length,
      };
    })
    .sort((a, b) => b.score - a.score);
  if ((scored[0]?.score ?? 0) > 0) return scored[0].task;
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * "Stop task two", "retry the Claude task", "prioritise task one".
 *
 * Requires an explicit task reference. Bare "stop" is the mic/speech stop the
 * user presses constantly, and resolving it to "cancel whatever is running"
 * would destroy work on a misheard word.
 */
function interpretTaskControl(
  text: string,
  tasks: MartaTask[],
  focusedTaskId?: string | null,
): StageLayoutCommandResult | null {
  const action = /\b(stop|cancel|kill|abort)\b/.test(text)
    ? "stop"
    : /\b(retry|try again|rerun|re run|restart)\b/.test(text)
      ? "retry"
      : /\b(prioriti[sz]e|priority|first|ahead of|before the others)\b/.test(
            text,
          )
        ? "prioritize"
        : null;
  if (!action) return null;
  // "stop listening", "stop talking" and "stop speaking" are voice controls.
  if (/\b(stop|cancel) (listening|talking|speaking|the mic)\b/.test(text)) {
    return null;
  }
  if (!/\b(task|worker|job|claude|qwen|mission|flow)\b/.test(text)) return null;

  const task = resolveTaskReference(text, tasks, focusedTaskId);
  if (!task) return null;

  return {
    command: {
      kind: "control-task",
      taskId: task.id,
      taskTitle: task.title,
      action,
      ...(action === "prioritize" ? { priority: 100 } : {}),
    },
    acknowledgement:
      action === "stop"
        ? `Stopping ${task.title}.`
        : action === "retry"
          ? `Retrying ${task.title}.`
          : `${task.title} goes first.`,
  };
}

function mentionedSurfaces(text: string): FluidSurfaceId[] {
  return SURFACE_ALIASES.filter(({ patterns }) =>
    patterns.some((pattern) => pattern.test(text)),
  ).map(({ id }) => id);
}

/** Pure command parsing, shared by typed and spoken turns and covered directly. */
export function interpretStageLayoutCommand(
  utterance: string,
  tasks: MartaTask[],
  focusedTaskId?: string | null,
): StageLayoutCommandResult | null {
  const text = normalized(utterance);
  if (!text) return null;

  // Task control is matched before layout: "stop task two" contains no layout
  // verb, but "hide task two" does, and mixing them up would silently kill work
  // the user only wanted off screen.
  const control = interpretTaskControl(text, tasks, focusedTaskId);
  if (control) return control;

  if (
    /\b(hide|close|collapse|dismiss)(?: me)? (?:the )?(?:transcript|conversation|chat|history)\b/.test(
      text,
    )
  ) {
    return {
      command: { kind: "hide-transcript" },
      acknowledgement: "I collapsed the conversation. The work has the screen.",
    };
  }
  if (
    /\b(show|open|expand|bring up)(?: me)? (?:the )?(?:transcript|conversation|chat|history)\b/.test(
      text,
    )
  ) {
    return {
      command: { kind: "show-transcript" },
      acknowledgement: "Here is the conversation so far.",
    };
  }

  if (
    /\b(hide|close|collapse) (?:the )?(?:task|agent) (?:deck|tasks|surfaces)\b/.test(
      text,
    )
  ) {
    return {
      command: { kind: "hide-task-deck" },
      acknowledgement:
        "I tucked the task deck away. The work is still running.",
    };
  }
  if (
    /\b(show|open|expand) (?:the )?(?:task|agent) (?:deck|tasks|surfaces)\b/.test(
      text,
    )
  ) {
    return {
      command: { kind: "show-task-deck" },
      acknowledgement: "The live task deck is back on the Stage.",
    };
  }
  if (
    /\b(tile|arrange|reset|show) (?:all |the )?(?:agent )?tasks\b/.test(text)
  ) {
    return {
      command: { kind: "tile-tasks" },
      acknowledgement: "I tiled every task evenly.",
    };
  }

  const surfaces = mentionedSurfaces(text);
  if (surfaces.length > 0 && /\b(hide|close|dismiss|remove)\b/.test(text)) {
    return {
      command: { kind: "dismiss", surfaces },
      acknowledgement: `I removed ${surfaces.join(" and ")} from the Stage.`,
    };
  }
  if (
    surfaces.length > 0 &&
    /\b(show|open|summon|bring|display|give me|let me see)\b/.test(text)
  ) {
    const task = /\btask\b/.test(text)
      ? resolveTaskReference(text, tasks, focusedTaskId)
      : null;
    return {
      command: {
        kind: "summon",
        surfaces: surfaces.map((id) => ({ id, taskId: task?.id })),
      },
      acknowledgement: `I added ${surfaces.join(" and ")} to the Stage.`,
    };
  }

  const resizeIntent =
    /\b(make|resize|enlarge|shrink|focus|maximize|maximise)\b/.test(text);
  if (!resizeIntent || !/\btask\b/.test(text)) return null;
  const task = resolveTaskReference(text, tasks, focusedTaskId);
  if (!task) return null;

  const emphasis: TaskSurfaceEmphasis = /\b(smaller|compact|shrink)\b/.test(
    text,
  )
    ? "normal"
    : /\b(focus|maximize|maximise|full ?screen|only)\b/.test(text)
      ? "focus"
      : "large";
  return {
    command: { kind: "emphasize-task", taskId: task.id, emphasis },
    acknowledgement:
      emphasis === "normal"
        ? `${task.title} is compact again.`
        : emphasis === "focus"
          ? `${task.title} is now the focus.`
          : `${task.title} now has more room; the other surfaces reflowed around it.`,
  };
}

export const applyStageLayoutCommandAtom = atom(
  null,
  (get, set, utterance: string): StageLayoutCommandResult | null => {
    const result = interpretStageLayoutCommand(
      utterance,
      get(projectedMartaTasksAtom),
      get(focusedTaskIdAtom),
    );
    if (!result) return null;

    const { command } = result;
    switch (command.kind) {
      case "emphasize-task":
        set(taskDeckCollapsedAtom, false);
        set(focusedTaskIdAtom, command.taskId);
        set(taskSurfaceEmphasisAtom, (previous) => ({
          ...(command.emphasis === "focus" ? {} : previous),
          [command.taskId]: command.emphasis,
        }));
        break;
      case "tile-tasks":
        set(taskDeckCollapsedAtom, false);
        set(taskSurfaceEmphasisAtom, {});
        break;
      case "summon":
        set(taskDeckCollapsedAtom, false);
        set(fluidSurfacesAtom, (previous) => {
          const next = [...previous];
          for (const surface of command.surfaces) {
            const key = `${surface.id}:${surface.taskId ?? "global"}`;
            if (
              !next.some(
                (item) => `${item.id}:${item.taskId ?? "global"}` === key,
              )
            ) {
              next.push(surface);
            }
          }
          return next;
        });
        break;
      case "dismiss":
        set(fluidSurfacesAtom, (previous) =>
          previous.filter((surface) => !command.surfaces.includes(surface.id)),
        );
        break;
      case "show-task-deck":
        set(taskDeckCollapsedAtom, false);
        break;
      case "hide-task-deck":
        set(taskDeckCollapsedAtom, true);
        break;
      case "show-transcript":
        set(transcriptExpandedAtom, true);
        break;
      case "hide-transcript":
        set(transcriptExpandedAtom, false);
        break;
      case "control-task":
        // The side effect is a main-process call, not an atom write, so this
        // only focuses the affected task. `Presence` performs the control and
        // reports what actually happened rather than the optimistic
        // acknowledgement — a stop that failed must not read as a stop.
        set(focusedTaskIdAtom, command.taskId);
        break;
    }
    return result;
  },
);

export const dismissFluidSurfaceAtom = atom(
  null,
  (_get, set, surface: FluidSurfaceRef) => {
    set(fluidSurfacesAtom, (previous) =>
      previous.filter(
        (item) => item.id !== surface.id || item.taskId !== surface.taskId,
      ),
    );
  },
);
