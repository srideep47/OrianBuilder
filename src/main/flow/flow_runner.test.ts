import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks
// Avoid pulling in Electron / the real DB. The runner only touches the DB when
// an appId is supplied; all tests here use appId-less intents (scratch dir).

vi.mock("@/db", () => ({
  db: { query: { apps: { findFirst: vi.fn() } } },
}));
vi.mock("@/paths/paths", () => ({
  getOrianBuilderAppPath: (p: string) => p,
  getUserDataPath: () => os.tmpdir(),
}));
vi.mock("@/ipc/utils/media_path_utils", () => ({
  ORIANBUILDER_MEDIA_DIR_NAME: ".orianbuilder/media",
}));

const executeMocks: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock("./capability_registry", () => ({
  getCapability: (id: string) => ({
    id,
    label: id,
    description: id,
    execute: executeMocks[id],
  }),
}));

import { runFlow } from "./flow_runner";
import type { CommandIntent } from "@/ipc/types/intent";

function makeIntent(steps: CommandIntent["steps"]): CommandIntent {
  return { goal: "test goal", steps };
}

beforeEach(() => {
  for (const k of Object.keys(executeMocks)) delete executeMocks[k];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runFlow", () => {
  it("runs steps in order and threads prior outputs", async () => {
    const seen: Record<string, unknown> = {};
    executeMocks["generate_image"] = vi.fn(async () => ({
      outputPath: "/tmp/hero.png",
    }));
    executeMocks["build_app"] = vi.fn(async (_input, ctx) => {
      seen.prior = ctx.priorOutputs;
      return { missionId: 42 };
    });

    const result = await runFlow(
      makeIntent([
        {
          id: "hero",
          capability: "generate_image",
          input: { prompt: "a hero" },
        },
        {
          id: "build",
          capability: "build_app",
          input: { goal: "build it" },
          dependsOn: ["hero"],
        },
      ]),
    );

    expect(result.status).toBe("completed");
    expect(result.steps.map((s) => s.status)).toEqual(["success", "success"]);
    expect(result.steps[0].output).toEqual({ outputPath: "/tmp/hero.png" });
    expect((seen.prior as Record<string, unknown>).hero).toEqual({
      outputPath: "/tmp/hero.png",
    });
  });

  it("skips a step whose dependency failed and reports partial", async () => {
    executeMocks["generate_image"] = vi.fn(async () => {
      throw new Error("gen boom");
    });
    executeMocks["build_app"] = vi.fn(async () => ({ missionId: 1 }));

    const result = await runFlow(
      makeIntent([
        { id: "hero", capability: "generate_image", input: { prompt: "x" } },
        {
          id: "build",
          capability: "build_app",
          input: {},
          dependsOn: ["hero"],
        },
      ]),
    );

    expect(result.status).toBe("failed");
    expect(result.steps[0].status).toBe("failed");
    expect(result.steps[0].error).toContain("gen boom");
    expect(result.steps[1].status).toBe("skipped");
    expect(executeMocks["build_app"]).not.toHaveBeenCalled();
  });

  it("reports partial when some steps succeed and some fail independently", async () => {
    executeMocks["generate_image"] = vi.fn(async () => ({ outputPath: "/a" }));
    executeMocks["generate_audio"] = vi.fn(async () => {
      throw new Error("audio boom");
    });

    const result = await runFlow(
      makeIntent([
        { id: "img", capability: "generate_image", input: { prompt: "x" } },
        { id: "aud", capability: "generate_audio", input: { prompt: "y" } },
      ]),
    );

    expect(result.status).toBe("partial");
  });

  it("reports partial when a step needs setup but keeps downstream steps running", async () => {
    executeMocks["generate_3d_asset"] = vi.fn(async () => ({
      setupRequired: true,
      reason: "Install 3D runtime",
    }));
    executeMocks["build_app"] = vi.fn(async () => ({ missionId: 1 }));

    const result = await runFlow(
      makeIntent([
        { id: "asset", capability: "generate_3d_asset", input: {} },
        {
          id: "build",
          capability: "build_app",
          input: {},
          dependsOn: ["asset"],
        },
      ]),
    );

    expect(result.status).toBe("partial");
    expect(result.steps.map((s) => s.status)).toEqual(["success", "success"]);
    expect(executeMocks["build_app"]).toHaveBeenCalled();
  });

  it("returns completed for an empty step list", async () => {
    const result = await runFlow(makeIntent([]));
    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(0);
  });
});
