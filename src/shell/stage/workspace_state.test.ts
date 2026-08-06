import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import type { MartaTask } from "@/ipc/types";
import { focusedTaskIdAtom } from "./task_state";
import {
  applyStageLayoutCommandAtom,
  fluidSurfacesAtom,
  interpretStageLayoutCommand,
  projectedMartaTasksAtom,
  resolveTaskReference,
  taskSurfaceEmphasisAtom,
  transcriptExpandedAtom,
} from "./workspace_state";

function task(
  id: string,
  worker: "claude" | "local",
  createdAt: number,
): MartaTask {
  return {
    id,
    kind: worker,
    title: `${worker === "claude" ? "Claude" : "Qwen"} website build`,
    goal: "Build and verify a website",
    workerLabel: worker === "claude" ? "Claude Code" : "Orion local agent",
    model: worker === "claude" ? "claude-haiku-4-5" : "Qwen3.5-4B",
    status: "running",
    phase: "Writing files",
    completedSteps: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

const CLAUDE_ONE = task("claude:one", "claude", 10);
const LOCAL_ONE = task("local:one", "local", 20);
const CLAUDE_TWO = task("claude:two", "claude", 30);
const TASKS = [LOCAL_ONE, CLAUDE_TWO, CLAUDE_ONE];

describe("task references", () => {
  it("resolves worker-qualified ordinals in stable creation order", () => {
    expect(resolveTaskReference("Claude task one", TASKS)?.id).toBe(
      CLAUDE_ONE.id,
    );
    expect(resolveTaskReference("Claude task two", TASKS)?.id).toBe(
      CLAUDE_TWO.id,
    );
    expect(resolveTaskReference("local task one", TASKS)?.id).toBe(
      LOCAL_ONE.id,
    );
  });

  it("resolves the focused task explicitly", () => {
    expect(
      resolveTaskReference("the current task", TASKS, CLAUDE_TWO.id)?.id,
    ).toBe(CLAUDE_TWO.id);
  });
});

describe("natural-language Stage layout commands", () => {
  it("makes Claude task one larger", () => {
    expect(
      interpretStageLayoutCommand("make Claude task one larger", TASKS),
    ).toMatchObject({
      command: {
        kind: "emphasize-task",
        taskId: CLAUDE_ONE.id,
        emphasis: "large",
      },
    });
  });

  it("summons several telemetry surfaces in one utterance", () => {
    expect(
      interpretStageLayoutCommand("show me the GPU and PC stats", TASKS),
    ).toMatchObject({
      command: {
        kind: "summon",
        surfaces: [{ id: "gpu" }, { id: "pc" }],
      },
    });
  });

  it("scopes a timeline to the named task", () => {
    expect(
      interpretStageLayoutCommand(
        "show Claude task two timeline",
        TASKS,
        CLAUDE_ONE.id,
      ),
    ).toMatchObject({
      command: {
        kind: "summon",
        surfaces: [{ id: "timeline", taskId: CLAUDE_TWO.id }],
      },
    });
  });

  it("does not intercept ordinary conversation", () => {
    expect(
      interpretStageLayoutCommand("why did the website task fail?", TASKS),
    ).toBeNull();
  });

  it("understands the synonyms a person actually uses for machine stats", () => {
    // The plan's own example sentence is "show model inference, GPU, and PC
    // health" — "health" and "load" have to resolve, or the feature looks broken
    // for the exact phrasing it was specified with.
    expect(
      interpretStageLayoutCommand(
        "show model inference, GPU and PC health",
        TASKS,
      ),
    ).toMatchObject({
      command: {
        kind: "summon",
        surfaces: [{ id: "gpu" }, { id: "pc" }, { id: "models" }],
      },
    });
    expect(
      interpretStageLayoutCommand("show me CPU load", TASKS),
    ).toMatchObject({ command: { kind: "summon", surfaces: [{ id: "pc" }] } });
  });

  it("summons and dismisses the conversation as a surface", () => {
    expect(
      interpretStageLayoutCommand("hide the conversation", TASKS),
    ).toMatchObject({ command: { kind: "hide-transcript" } });
    expect(
      interpretStageLayoutCommand("show me the transcript", TASKS),
    ).toMatchObject({ command: { kind: "show-transcript" } });
  });

  it("applies emphasis and fluid surfaces to the shared Stage state", () => {
    const store = createStore();
    store.set(projectedMartaTasksAtom, TASKS);

    store.set(applyStageLayoutCommandAtom, "make Claude task one larger");
    expect(store.get(focusedTaskIdAtom)).toBe(CLAUDE_ONE.id);
    expect(store.get(taskSurfaceEmphasisAtom)).toEqual({
      [CLAUDE_ONE.id]: "large",
    });

    store.set(applyStageLayoutCommandAtom, "show GPU and model stats");
    expect(store.get(fluidSurfacesAtom)).toEqual([
      { id: "gpu", taskId: undefined },
      { id: "models", taskId: undefined },
    ]);

    store.set(applyStageLayoutCommandAtom, "hide the conversation");
    expect(store.get(transcriptExpandedAtom)).toBe(false);
    store.set(applyStageLayoutCommandAtom, "show the conversation");
    expect(store.get(transcriptExpandedAtom)).toBe(true);
  });
});

describe("task control commands", () => {
  it("stops a named task", () => {
    expect(
      interpretStageLayoutCommand("stop Claude task two", TASKS),
    ).toMatchObject({
      command: {
        kind: "control-task",
        taskId: CLAUDE_TWO.id,
        action: "stop",
      },
    });
  });

  it("retries and reprioritises", () => {
    expect(
      interpretStageLayoutCommand("retry the local task", TASKS),
    ).toMatchObject({
      command: { kind: "control-task", taskId: LOCAL_ONE.id, action: "retry" },
    });
    expect(
      interpretStageLayoutCommand("prioritise Claude task one", TASKS),
    ).toMatchObject({
      command: {
        kind: "control-task",
        taskId: CLAUDE_ONE.id,
        action: "prioritize",
        priority: 100,
      },
    });
  });

  it("never treats a voice control as a request to kill work", () => {
    // "Stop listening" and "stop talking" are said constantly. Resolving either
    // to "cancel whatever is running" would destroy work on a misheard word.
    for (const utterance of [
      "stop listening",
      "stop talking",
      "stop speaking",
      "stop",
    ]) {
      expect(
        interpretStageLayoutCommand(utterance, TASKS),
        utterance,
      ).toBeNull();
    }
  });

  it("does not confuse hiding a task with stopping it", () => {
    expect(
      interpretStageLayoutCommand("hide the task deck", TASKS),
    ).toMatchObject({ command: { kind: "hide-task-deck" } });
  });

  it("needs a resolvable task, not just the word 'stop'", () => {
    expect(interpretStageLayoutCommand("stop the task", [])).toBeNull();
  });

  it("focuses the affected task without pretending the stop succeeded", () => {
    // The IPC call is the caller's job; the atom must not mark anything stopped,
    // because a failed stop that reads as a stop is worse than no control.
    const store = createStore();
    store.set(projectedMartaTasksAtom, TASKS);
    const result = store.set(
      applyStageLayoutCommandAtom,
      "stop Claude task two",
    );
    expect(result?.command.kind).toBe("control-task");
    expect(store.get(focusedTaskIdAtom)).toBe(CLAUDE_TWO.id);
  });
});
