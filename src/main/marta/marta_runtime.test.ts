/**
 * The turn loop, driven by a scripted model.
 *
 * The interesting cases are all about a small model behaving badly: emitting
 * malformed arguments, naming tools that do not exist, and looping. Those are
 * not edge cases at 4B — they are Tuesday — so the loop has to make progress or
 * fail out loud rather than hang.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  completeStream: vi.fn(),
  invokeAction: vi.fn(),
  collectWorldState: vi.fn(),
  renderWorldState: vi.fn(() => "On screen: nothing — the Stage is empty."),
}));

vi.mock("./marta_model", () => ({
  getMartaModel: () => ({
    complete: mocks.complete,
    completeStream: mocks.completeStream,
  }),
}));

vi.mock("./invoke_action", () => ({
  invokeAction: mocks.invokeAction,
  summariseActionResult: (_actionId: string, data: unknown) =>
    JSON.stringify(data),
}));

vi.mock("./graph/world_state", () => ({
  collectWorldState: mocks.collectWorldState,
  renderWorldState: mocks.renderWorldState,
}));

import {
  answerMartaIdentityFromWorldState,
  MartaRuntime,
  MAX_TOOL_ROUNDS,
  setDelegateExecutor,
  _resetMartaRuntimeForTests,
  type MartaTurnEvent,
} from "./marta_runtime";
import { actionIdToToolName } from "./prompt";

/** A completion with no tool calls — a plain spoken answer. */
function says(text: string) {
  return {
    content: text,
    toolCalls: [],
    finishReason: "stop",
    promptTokens: 10,
    completionTokens: 5,
    durationMs: 20,
  };
}

/** A completion that calls one tool. */
function calls(name: string, args: unknown, id = "call-1") {
  return {
    content: "",
    toolCalls: [
      {
        id,
        type: "function" as const,
        function: {
          name,
          arguments: typeof args === "string" ? args : JSON.stringify(args),
        },
      },
    ],
    finishReason: "tool_calls",
    promptTokens: 10,
    completionTokens: 5,
    durationMs: 20,
  };
}

function collect(): {
  events: MartaTurnEvent[];
  on: (e: MartaTurnEvent) => void;
} {
  const events: MartaTurnEvent[] = [];
  return { events, on: (e) => events.push(e) };
}

describe("trusted live identity", () => {
  it("answers Marta's own model from world state without confusing the engine", async () => {
    mocks.renderWorldState.mockReturnValueOnce(
      "Model resident: Qwen3.6-35B (llm, 24GB)\nYou are running as qwen3.5-4b on GPU",
    );
    const runtime = new MartaRuntime();
    const { events, on } = collect();

    const reply = await runtime.runTurn(
      "Which Marta model is running right now, on GPU or CPU?",
      {},
      on,
    );

    expect(reply).toBe(
      "I'm running as qwen3.5-4b on GPU. Orion's selected big engine model is separate from me.",
    );
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.completeStream).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ kind: "done", rounds: 0 });
  });

  it("does not intercept a general model recommendation question", () => {
    expect(
      answerMartaIdentityFromWorldState(
        "Which model should we use for coding?",
        "You are running as qwen3.5-4b on GPU",
      ),
    ).toBeNull();
  });

  it("does not intercept a big-brain delegation request that mentions GPU", () => {
    expect(
      answerMartaIdentityFromWorldState(
        "Use your local big-brain delegate and the Qwen3.6 35B model to answer this carefully: for a desktop assistant with a 4B orchestrator and a 35B expert sharing a 16GB GPU, propose a deadlock-free handoff policy in exactly three concise bullets.",
        "You are running as unsloth/Qwen3.5-4B-GGUF on GPU",
      ),
    ).toBeNull();
  });
});

beforeEach(() => {
  _resetMartaRuntimeForTests();
  mocks.complete.mockReset();
  mocks.completeStream.mockReset();
  // Existing loop tests are about tools/history, not transport. Keep their
  // scripted `complete` responses while explicitly exercising streaming below.
  mocks.completeStream.mockImplementation(async (...args: unknown[]) =>
    mocks.complete(...args.slice(0, 2)),
  );
  mocks.invokeAction.mockReset();
  mocks.collectWorldState.mockResolvedValue({});
  mocks.invokeAction.mockResolvedValue({
    ok: true,
    data: { ok: 1 },
    durationMs: 1,
  });
});

describe("a plain answer", () => {
  it("emits narration fragments before the completed reply", async () => {
    mocks.completeStream.mockImplementationOnce(
      async (
        _messages: unknown,
        _options: unknown,
        onDelta: (text: string) => void,
      ) => {
        onDelta("Three ");
        onDelta("projects.");
        return says("Three projects.");
      },
    );
    const runtime = new MartaRuntime();
    const { events, on } = collect();

    await expect(runtime.runTurn("how many projects?", {}, on)).resolves.toBe(
      "Three projects.",
    );
    expect(events.map((event) => event.kind)).toEqual([
      "thinking",
      "text-delta",
      "text",
      "done",
    ]);
    expect(events.find((event) => event.kind === "text-delta")).toEqual({
      kind: "text-delta",
      text: "Three projects.",
    });
  });

  it("returns the text and records it in history", async () => {
    mocks.complete.mockResolvedValueOnce(says("Three projects."));
    const runtime = new MartaRuntime();
    const { events, on } = collect();

    const text = await runtime.runTurn("how many projects?", {}, on);

    expect(text).toBe("Three projects.");
    expect(events.map((e) => e.kind)).toEqual(["thinking", "text", "done"]);
    expect(runtime.getHistory()).toEqual([
      { role: "user", content: "how many projects?" },
      { role: "assistant", content: "Three projects." },
    ]);
  });

  it("carries history into the next turn", async () => {
    mocks.complete.mockResolvedValue(says("ok"));
    const runtime = new MartaRuntime();
    await runtime.runTurn("first", {}, () => {});
    await runtime.runTurn("second", {}, () => {});

    const messages = mocks.complete.mock.calls[1][0];
    const roles = messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
  });
});

describe("tool calls", () => {
  it("runs an action, feeds the result back, and answers", async () => {
    mocks.complete
      .mockResolvedValueOnce(calls(actionIdToToolName("app.listApps"), {}))
      .mockResolvedValueOnce(says("You have two."));
    mocks.invokeAction.mockResolvedValue({
      ok: true,
      data: { apps: ["a", "b"] },
      durationMs: 3,
    });

    const runtime = new MartaRuntime();
    const { events, on } = collect();
    const text = await runtime.runTurn("list my projects", {}, on);

    expect(mocks.invokeAction).toHaveBeenCalledWith(
      "app.listApps",
      {},
      { approved: false },
    );
    expect(text).toBe("You have two.");
    expect(events.map((e) => e.kind)).toContain("tool-start");
    expect(events.map((e) => e.kind)).toContain("tool-end");

    // The tool result must reach the model as a `tool` message tied to its call.
    const secondCall = mocks.complete.mock.calls[1][0];
    const toolMessage = secondCall.find(
      (m: { role: string }) => m.role === "tool",
    );
    expect(toolMessage.tool_call_id).toBe("call-1");
    expect(toolMessage.content).toContain("apps");
  });

  it("passes an approval through for exactly the approved action", async () => {
    mocks.complete
      .mockResolvedValueOnce(
        calls(actionIdToToolName("workspaceFiles.remove"), { path: "x" }),
      )
      .mockResolvedValueOnce(says("Deleted."));

    const runtime = new MartaRuntime();
    await runtime.runTurn(
      "delete it",
      { approvedActions: ["workspaceFiles.remove"] },
      () => {},
    );

    expect(mocks.invokeAction).toHaveBeenCalledWith(
      "workspaceFiles.remove",
      { path: "x" },
      { approved: true },
    );
  });

  it("does not approve a different action than the one approved", async () => {
    mocks.complete
      .mockResolvedValueOnce(calls(actionIdToToolName("github.push"), {}))
      .mockResolvedValueOnce(says("ok"));

    const runtime = new MartaRuntime();
    await runtime.runTurn(
      "push it",
      { approvedActions: ["workspaceFiles.remove"] },
      () => {},
    );

    expect(mocks.invokeAction).toHaveBeenCalledWith(
      "github.push",
      {},
      { approved: false },
    );
  });

  it("feeds a failure back so the model can recover", async () => {
    mocks.complete
      .mockResolvedValueOnce(
        calls(actionIdToToolName("app.getApp"), { value: 9 }),
      )
      .mockResolvedValueOnce(says("That project does not exist."));
    mocks.invokeAction.mockResolvedValue({
      ok: false,
      error: "App 9 not found",
      durationMs: 1,
    });

    const runtime = new MartaRuntime();
    const text = await runtime.runTurn("open project 9", {}, () => {});

    const secondCall = mocks.complete.mock.calls[1][0];
    const toolMessage = secondCall.find(
      (m: { role: string }) => m.role === "tool",
    );
    expect(toolMessage.content).toBe("App 9 not found");
    expect(text).toBe("That project does not exist.");
  });
});

describe("misbehaving models", () => {
  it("never exposes raw tool XML as a user-facing answer", async () => {
    mocks.complete.mockResolvedValueOnce(
      says(
        '<tool_call><function=marta__listTasks>{"limit":10}</function></tool_call>',
      ),
    );
    const runtime = new MartaRuntime();
    const { events, on } = collect();

    const reply = await runtime.runTurn("is it happening?", {}, on);

    expect(reply).toContain("invalid internal tool command");
    expect(reply).not.toContain("tool_call");
    expect(JSON.stringify(events)).not.toContain("marta__listTasks");
    expect(JSON.stringify(runtime.getHistory())).not.toContain(
      "marta__listTasks",
    );
  });

  it("sanitizes split protocol before streaming it to the Stage", async () => {
    mocks.completeStream.mockImplementationOnce(
      async (
        _messages: unknown,
        _options: unknown,
        onDelta: (text: string) => void,
      ) => {
        onDelta("Checking now. <tool_");
        onDelta("call><function=marta__listTasks>");
        onDelta("{}</function></tool_call>");
        return says(
          "Checking now. <tool_call><function=marta__listTasks>{}</function></tool_call>",
        );
      },
    );
    const runtime = new MartaRuntime();
    const { events, on } = collect();

    await runtime.runTurn("check status", {}, on);

    expect(events.filter((event) => event.kind === "text-delta")).toEqual([
      { kind: "text-delta", text: "Checking now." },
    ]);
    expect(JSON.stringify(events)).not.toContain("tool_call");
    expect(JSON.stringify(events)).not.toContain("marta__listTasks");
  });

  it("tells the model when its arguments are not valid JSON", async () => {
    mocks.complete
      .mockResolvedValueOnce(
        calls(actionIdToToolName("app.listApps"), "{not json"),
      )
      .mockResolvedValueOnce(says("Sorry."));

    const runtime = new MartaRuntime();
    await runtime.runTurn("list", {}, () => {});

    const toolMessage = mocks.complete.mock.calls[1][0].find(
      (m: { role: string }) => m.role === "tool",
    );
    expect(toolMessage.content).toContain("not valid JSON");
    // And it must not have tried to run anything with garbage arguments.
    expect(mocks.invokeAction).not.toHaveBeenCalled();
  });

  it("rejects an unknown surface by name", async () => {
    mocks.complete
      .mockResolvedValueOnce(
        calls("show_surface", { surfaceId: "not.a.surface" }),
      )
      .mockResolvedValueOnce(says("Sorry."));

    const runtime = new MartaRuntime();
    const { events, on } = collect();
    await runtime.runTurn("show me that", {}, on);

    expect(events.some((e) => e.kind === "surface")).toBe(false);
    const toolMessage = mocks.complete.mock.calls[1][0].find(
      (m: { role: string }) => m.role === "tool",
    );
    expect(toolMessage.content).toContain("No surface");
  });

  it("stops after the round cap instead of looping forever", async () => {
    // A model that has misunderstood will keep calling the same tool. Without
    // a cap this turn never ends, which for a voice assistant is silence.
    mocks.complete.mockResolvedValue(
      calls(actionIdToToolName("app.listApps"), {}),
    );

    const runtime = new MartaRuntime();
    const { events, on } = collect();
    const text = await runtime.runTurn("do the thing", {}, on);

    expect(mocks.complete).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
    // It must say something rather than returning silence.
    expect(text.length).toBeGreaterThan(0);
    const done = events.find((e) => e.kind === "done");
    expect(done).toMatchObject({ rounds: MAX_TOOL_ROUNDS });
  });

  it("reports a model failure as an error event, not a throw", async () => {
    mocks.complete.mockRejectedValueOnce(new Error("connection refused"));
    const runtime = new MartaRuntime();
    const { events, on } = collect();

    await expect(runtime.runTurn("hello", {}, on)).resolves.toBe("");
    expect(events.at(-1)).toEqual({
      kind: "error",
      message: "connection refused",
    });
  });
});

describe("surfaces", () => {
  it("emits a surface event the Stage can act on", async () => {
    mocks.complete
      .mockResolvedValueOnce(
        calls("show_surface", {
          surfaceId: "create.studio",
          params: { appId: 3 },
        }),
      )
      .mockResolvedValueOnce(says("Here it is."));

    const runtime = new MartaRuntime();
    const { events, on } = collect();
    await runtime.runTurn("open the media studio", {}, on);

    expect(events).toContainEqual({
      kind: "surface",
      surfaceId: "create.studio",
      params: { appId: 3 },
    });
  });
});

describe("delegation", () => {
  it("routes to the delegate executor", async () => {
    const executor = vi
      .fn()
      .mockResolvedValue({ ok: true, summary: "Started." });
    setDelegateExecutor(executor);
    mocks.complete
      .mockResolvedValueOnce(
        calls("delegate_workflow", { command: "make me a logo" }),
      )
      .mockResolvedValueOnce(says("On it."));

    const runtime = new MartaRuntime();
    await runtime.runTurn("make me a logo", {}, () => {});

    expect(executor).toHaveBeenCalledWith({
      delegateId: "delegate.workflow",
      args: { command: "make me a logo" },
      userText: "make me a logo",
      delegationSelection: undefined,
      signal: undefined,
    });
  });

  it("emits a structured coding-worker choice before work starts", async () => {
    const executor = vi.fn().mockResolvedValue({
      ok: true,
      summary: "Waiting for the user's choice.",
      choice: {
        requestId: "choice-1",
        appId: 7,
        goal: "build the site",
        readOnly: false,
      },
    });
    setDelegateExecutor(executor);
    mocks.complete
      .mockResolvedValueOnce(
        calls("delegate_code", { goal: "build the site", appId: 7 }),
      )
      .mockResolvedValueOnce(says("Choose a coding worker on screen."));

    const runtime = new MartaRuntime();
    const { events, on } = collect();
    await runtime.runTurn("build the site", {}, on);

    expect(events).toContainEqual({
      kind: "delegation-choice",
      requestId: "choice-1",
      appId: 7,
      goal: "build the site",
      readOnly: false,
    });
  });

  it("passes a user-selected Claude model and effort to the delegate", async () => {
    const executor = vi
      .fn()
      .mockResolvedValue({ ok: true, summary: "Started." });
    setDelegateExecutor(executor);
    mocks.complete
      .mockResolvedValueOnce(
        calls("delegate_code", { goal: "build the site", appId: 7 }),
      )
      .mockResolvedValueOnce(says("Started."));

    const runtime = new MartaRuntime();
    await runtime.runTurn(
      "build the site",
      {
        delegationSelection: {
          worker: "claude",
          model: "claude-haiku-4-5",
          effort: "low",
        },
      },
      () => {},
    );

    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        delegationSelection: {
          worker: "claude",
          model: "claude-haiku-4-5",
          effort: "low",
        },
      }),
    );
  });

  it("uses a complete worker choice from the initial utterance", async () => {
    const executor = vi
      .fn()
      .mockResolvedValue({ ok: true, summary: "Started." });
    setDelegateExecutor(executor);
    mocks.complete
      .mockResolvedValueOnce(
        calls("delegate_code", { goal: "build the site", appId: 7 }),
      )
      .mockResolvedValueOnce(says("Started."));

    const runtime = new MartaRuntime();
    await runtime.runTurn(
      "Build the site with Claude Haiku, low effort",
      {},
      () => {},
    );

    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        delegationSelection: {
          worker: "claude",
          model: "claude-haiku-4-5",
          effort: "low",
          remember: undefined,
        },
      }),
    );
  });

  it("says so when no executor is wired rather than pretending", async () => {
    setDelegateExecutor(null);
    mocks.complete
      .mockResolvedValueOnce(
        calls("delegate_code", { goal: "fix it", appId: 1 }),
      )
      .mockResolvedValueOnce(says("I can't."));

    const runtime = new MartaRuntime();
    await runtime.runTurn("fix the bug", {}, () => {});

    const toolMessage = mocks.complete.mock.calls[1][0].find(
      (m: { role: string }) => m.role === "tool",
    );
    expect(toolMessage.content).toContain("not available");
  });
});

describe("cancellation", () => {
  it("stops before calling the model when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const runtime = new MartaRuntime();
    const { events, on } = collect();
    await runtime.runTurn("hello", { signal: controller.signal }, on);

    expect(mocks.complete).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ kind: "error" });
  });

  it("aborts an in-flight completion and restores the prior conversation", async () => {
    mocks.complete.mockImplementationOnce(
      (_messages: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new Error("request aborted")),
            { once: true },
          );
        }),
    );

    const controller = new AbortController();
    const runtime = new MartaRuntime();
    const { events, on } = collect();
    const pending = runtime.runTurn(
      "first request",
      { signal: controller.signal },
      on,
    );

    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).resolves.toBe("");
    expect(runtime.getHistory()).toEqual([]);
    expect(events.at(-1)).toEqual({ kind: "error", message: "Cancelled." });
  });
});

describe("history trimming", () => {
  it("never leaves an orphaned tool result at the head of history", async () => {
    // An OpenAI-format `tool` message with no preceding call is a hard error,
    // so trimming has to skip past a whole call/result group.
    mocks.complete.mockResolvedValue(says("ok"));
    const runtime = new MartaRuntime();
    for (let i = 0; i < 30; i++) {
      await runtime.runTurn(`turn ${i}`, {}, () => {});
    }
    const history = runtime.getHistory();
    expect(history[0].role).not.toBe("tool");
    expect(history.length).toBeLessThanOrEqual(24);
  });

  it("clears on request", async () => {
    mocks.complete.mockResolvedValue(says("ok"));
    const runtime = new MartaRuntime();
    await runtime.runTurn("hello", {}, () => {});
    runtime.clearHistory();
    expect(runtime.getHistory()).toEqual([]);
  });
});
