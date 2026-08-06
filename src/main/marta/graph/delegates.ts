/**
 * The bigger brains.
 *
 * Marta is a 4B-class orchestrator. She is very good at knowing *what* the app
 * can do and *which* thing to reach for, and she is not the model that should
 * be writing a refactor or planning a nine-step generation pipeline. Delegates
 * are the escape hatch: each one is a larger, slower, more capable executor
 * that Marta hands a goal to and then narrates.
 *
 * `weight` exists so she doesn't spawn a supervised mission to rename a
 * variable. Light delegates return within a turn; heavy ones run for minutes to
 * hours and report progress through the ambient rail.
 *
 * These are separate from actions because the *contract* is different. An
 * action is a function call with a known return shape. A delegate is a goal
 * handed to something that will make its own decisions, and it needs a
 * supervision story — progress, interruption, permission — that a plain IPC
 * call has no place for.
 */

import type { DelegateNode } from "./types";

export const DELEGATES: ReadonlyArray<DelegateNode> = [
  {
    kind: "delegate",
    id: "delegate.brain",
    title: "Local big brain",
    summary:
      "Ask the on-demand Qwen3.6 35B-A3B local reasoning model to solve a difficult question, compare approaches, diagnose a complex problem, or produce a careful plan. Use it when the answer needs deeper reasoning than your companion model, but not for current web facts or direct code edits.",
    weight: "heavy",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The complete problem and relevant context. State exactly what decision or answer is needed.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    keywords: [
      "think deeply",
      "complex",
      "reason",
      "analyze",
      "compare approaches",
      "architecture",
      "difficult",
    ],
  },
  {
    kind: "delegate",
    id: "delegate.code",
    title: "Coding worker",
    summary:
      "Hand a coding task to the user's chosen worker: Orion's agentic local model or Claude Code. The trusted delegate asks conversationally for provider, model and effort when no default is saved. Use this for anything that needs real reasoning over source. Do not choose a paid worker yourself.",
    weight: "heavy",
    parameters: {
      type: "object",
      properties: {
        appId: {
          type: "number",
          description: "The project to work in.",
        },
        goal: {
          type: "string",
          description:
            "What to accomplish, in full sentences. Include the acceptance criteria — Claude Code cannot ask you follow-up questions mid-turn.",
        },
        readOnly: {
          type: "boolean",
          description:
            "True to investigate and report without editing any files. Prefer this when the user asked a question rather than for a change.",
        },
      },
      required: ["appId", "goal"],
      additionalProperties: false,
    },
    keywords: [
      "code",
      "refactor",
      "fix the bug",
      "implement",
      "why does",
      "explain the code",
      "write",
    ],
  },
  {
    kind: "delegate",
    id: "delegate.workflow",
    title: "Flow runner",
    summary:
      "Run a multi-step creative or build workflow: generate media, process 3D meshes, edit Godot scenes, run tests, export games, deploy, research, and build apps, chained through a shared artifact bus. Use this whenever the request has more than one output or mixes modalities.",
    weight: "heavy",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The user's request, restated as one complete sentence. The flow runner parses it into steps itself — do not decompose it yourself.",
        },
        appId: {
          type: "number",
          description: "Project to attach the run's outputs to, if any.",
        },
        maxParallel: {
          type: "number",
          description:
            "How many independent steps may run at once. Leave unset for sequential, which is right when everything runs on the local GPU.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    keywords: [
      "and then",
      "pipeline",
      "workflow",
      "make me a whole",
      "generate and build",
    ],
  },
  {
    kind: "delegate",
    id: "delegate.mission",
    title: "Autonomous mission",
    summary:
      "Start a long autonomous run against a project that continues without supervision, checkpoints its work, and asks permission before risky steps. Use only for goals measured in hours, not minutes.",
    weight: "heavy",
    parameters: {
      type: "object",
      properties: {
        appId: { type: "number", description: "The project to work in." },
        title: { type: "string", description: "Short name for the mission." },
        goal: {
          type: "string",
          description: "The full objective, including how to know it is done.",
        },
        autonomyProfile: {
          type: "string",
          enum: ["supervised", "trusted-workspace", "full-autopilot-sandbox"],
          description:
            "How much it may do unattended. Default to 'supervised' unless the user explicitly asked for autonomy.",
        },
      },
      required: ["appId", "title", "goal"],
      additionalProperties: false,
    },
    keywords: [
      "overnight",
      "keep working",
      "autonomous",
      "while I'm away",
      "mission",
    ],
  },
  {
    kind: "delegate",
    id: "delegate.research",
    title: "Web research",
    summary:
      "Search and read the web to answer a question you do not know the answer to. Use this rather than guessing — your training data is older than the user's problem.",
    weight: "light",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question, self-contained.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    keywords: ["search", "look up", "what is", "latest", "current", "news"],
  },
];

export const DELEGATES_BY_ID: ReadonlyMap<string, DelegateNode> = new Map(
  DELEGATES.map((d) => [d.id, d]),
);
