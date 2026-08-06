/**
 * The invoker is the enforcement point between a language model and 340 IPC
 * handlers. Everything upstream is advisory, so these tests are mostly about
 * what happens when the model is wrong, hostile, or hallucinating.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  getRegisteredHandler: vi.fn(),
  getAllWindows: vi.fn(() => []),
  getFocusedWindow: vi.fn(() => null),
}));

vi.mock("@/ipc/handlers/base", () => ({
  getRegisteredHandler: mocks.getRegisteredHandler,
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: mocks.getAllWindows,
    getFocusedWindow: mocks.getFocusedWindow,
  },
}));

import { _resetGraphForTests } from "./graph/build_graph";
import {
  invokeAction,
  summariseActionResult,
  summariseResult,
} from "./invoke_action";

/** Register a fake handler for a channel. */
function stubHandler(
  channel: string,
  input: z.ZodType,
  handler: (event: unknown, parsed: unknown) => unknown,
) {
  mocks.getRegisteredHandler.mockImplementation((c: string) =>
    c === channel
      ? { contract: { channel, input, output: z.unknown() }, handler }
      : undefined,
  );
}

beforeEach(() => {
  _resetGraphForTests();
  mocks.getRegisteredHandler.mockReset();
  mocks.getRegisteredHandler.mockReturnValue(undefined);
});

describe("grant enforcement", () => {
  it("refuses an action that was never granted", async () => {
    // `system.resetAll` is a real contract, deliberately withheld. Naming it
    // exactly must not work.
    const result = await invokeAction("system.resetAll", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No such action");
    expect(mocks.getRegisteredHandler).not.toHaveBeenCalled();
  });

  it("refuses an invented action", async () => {
    const result = await invokeAction("app.deleteEverything", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No such action");
  });

  it("does not reveal that a withheld action exists", async () => {
    // Telling the model "that exists but you may not use it" invites retries.
    // Both cases must produce the same message apart from the echoed id.
    const withheld = await invokeAction("system.resetAll", {});
    const invented = await invokeAction("system.notARealThing", {});
    const shape = (message: string | undefined) =>
      message?.replace(/"[^"]*"/, '"<id>"');
    expect(shape(withheld.error)).toBe(shape(invented.error));
    expect(withheld.error).not.toMatch(
      /withheld|denied|permission|not allowed/i,
    );
  });
});

describe("confirmation gate", () => {
  it("refuses a gated action without approval, before touching the handler", async () => {
    stubHandler("workspace-files:remove", z.unknown(), () => "deleted");
    const result = await invokeAction("workspaceFiles.remove", {
      appId: 1,
      path: "src",
    });

    expect(result.ok).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    // The important half: refusing must not have run anything.
    expect(mocks.getRegisteredHandler).not.toHaveBeenCalled();
  });

  it("runs a gated action once approved", async () => {
    const handler = vi.fn(() => ({ removed: true }));
    stubHandler(
      "workspace-files:remove",
      z.object({ appId: z.number(), path: z.string() }),
      handler,
    );

    const result = await invokeAction(
      "workspaceFiles.remove",
      { appId: 1, path: "src/old.ts" },
      { approved: true },
    );

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not require approval for a read", async () => {
    stubHandler("list-apps", z.unknown(), () => ({ apps: [] }));
    const result = await invokeAction("app.listApps", {});
    expect(result.ok).toBe(true);
  });
});

describe("argument handling", () => {
  it("unwraps a scalar contract's `value` before validating", async () => {
    // `app.getApp` takes a bare number; the tool schema wraps it because
    // tool-calling APIs require an object. Without unwrapping, every
    // scalar-input action would fail Zod validation.
    const handler = vi.fn(() => ({ id: 12 }));
    stubHandler("get-app", z.number(), handler);

    const result = await invokeAction("app.getApp", { value: 12 });
    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith(expect.anything(), 12);
  });

  it("returns field-level detail so the model can fix its own call", async () => {
    stubHandler(
      "create-app",
      z.object({ name: z.string(), templateId: z.string() }),
      () => ({}),
    );

    const result = await invokeAction("app.createApp", { name: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("templateId");
  });
});

describe("failure handling", () => {
  it("reports a throwing handler instead of propagating", async () => {
    // A failed tool call is a normal event in an agent loop. Throwing here
    // would end the turn instead of letting the model recover.
    stubHandler("list-apps", z.unknown(), () => {
      throw new Error("database is locked");
    });

    const result = await invokeAction("app.listApps", {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("database is locked");
  });

  it("reports a missing handler rather than crashing", async () => {
    mocks.getRegisteredHandler.mockReturnValue(undefined);
    const result = await invokeAction("app.listApps", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not available");
  });

  it("times the call either way", async () => {
    stubHandler("list-apps", z.unknown(), () => ({ apps: [] }));
    const ok = await invokeAction("app.listApps", {});
    const bad = await invokeAction("nope.nope", {});
    expect(ok.durationMs).toBeGreaterThanOrEqual(0);
    expect(bad.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("summariseResult", () => {
  it("passes small results through", () => {
    expect(summariseResult({ a: 1 })).toBe('{"a":1}');
  });

  it("marks truncation explicitly", () => {
    // The model must be able to tell "that's all of it" from "there was more".
    const long = summariseResult("x".repeat(5_000), 100);
    expect(long.length).toBeLessThan(400);
    expect(long).toContain("truncated");
    expect(long).toContain("4900 more characters");
  });

  it("says so when there is no output", () => {
    expect(summariseResult(undefined)).toBe("(no output)");
    expect(summariseResult(null)).toBe("(no output)");
  });

  it("survives a value JSON cannot serialise", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => summariseResult(circular)).not.toThrow();
  });
});

describe("summariseActionResult", () => {
  it("distinguishes engine settings from Marta and removes private fields", () => {
    const summary = summariseActionResult("settings.getUserSettings", {
      selectedModel: { name: "Qwen3.6-35B", provider: "embedded" },
      telemetryUserId: "private-id",
      providerSettings: { cloud: { apiKey: "secret" } },
      embeddedConfig: {
        modelPath: "D:/models/qwen.gguf",
        inferenceBackend: "llama-cpp",
        contextSize: 16_384,
      },
    });

    expect(summary).toContain("Orion engine preferences");
    expect(summary).toContain("Qwen3.6-35B");
    expect(summary).not.toContain("private-id");
    expect(summary).not.toContain("secret");
  });

  it("does not alter other action results", () => {
    expect(summariseActionResult("app.listApps", { apps: [] })).toBe(
      '{"apps":[]}',
    );
  });
});
