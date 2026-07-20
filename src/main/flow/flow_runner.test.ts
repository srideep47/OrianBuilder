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

import { runFlow, resumeFlow } from "./flow_runner";
import { setFlowReviewer, type FlowReviewCheckpoint } from "./flow_review";
import { getModelGate, _resetModelGateForTests } from "./model_gate";
import type { CommandIntent } from "@/ipc/types/intent";

function makeIntent(steps: CommandIntent["steps"]): CommandIntent {
  return { goal: "test goal", steps };
}

beforeEach(() => {
  for (const k of Object.keys(executeMocks)) delete executeMocks[k];
});

afterEach(() => {
  setFlowReviewer(null);
  _resetModelGateForTests();
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

  it("reports provider progress with its flow step identity", async () => {
    executeMocks["generate_image"] = vi.fn(async (_input, ctx) => {
      ctx.onMediaProgress?.({ stage: "Denoising", progress: 0.5 });
      return { outputPath: "/tmp/progress.png" };
    });
    const onMediaProgress = vi.fn();

    await runFlow(
      makeIntent([
        {
          id: "hero",
          capability: "generate_image",
          input: { prompt: "a hero" },
        },
      ]),
      { onMediaProgress },
    );

    expect(onMediaProgress).toHaveBeenCalledWith({
      stepId: "hero",
      capability: "generate_image",
      stage: "Denoising",
      progress: 0.5,
    });
  });

  it("does not start queued steps after cancellation", async () => {
    const controller = new AbortController();
    executeMocks["generate_image"] = vi.fn(async () => {
      controller.abort();
      throw new Error("image generation was cancelled");
    });
    executeMocks["generate_video"] = vi.fn(async () => ({
      outputPath: "/tmp/video.mp4",
    }));

    const result = await runFlow(
      makeIntent([
        { id: "img", capability: "generate_image", input: { prompt: "x" } },
        { id: "vid", capability: "generate_video", input: { prompt: "y" } },
      ]),
      { signal: controller.signal },
    );

    expect(result.steps.map((step) => step.status)).toEqual([
      "failed",
      "skipped",
    ]);
    expect(executeMocks["generate_video"]).not.toHaveBeenCalled();
  });
});

describe("review checkpoints", () => {
  it("invokes the reviewer at a modality-batch boundary and applies prompt revisions", async () => {
    const seenPrompts: string[] = [];
    executeMocks["generate_image"] = vi.fn(async (input) => ({
      outputPath: `/tmp/${input.prompt}.png`,
    }));
    executeMocks["generate_video"] = vi.fn(async (input) => {
      seenPrompts.push(input.prompt);
      return { outputPath: "/tmp/v.mp4" };
    });

    const reviewer = vi.fn(async (_cp: FlowReviewCheckpoint) => ({
      promptRevisions: { promo: "revised promo prompt" },
    }));
    setFlowReviewer(reviewer);

    const result = await runFlow(
      makeIntent([
        { id: "logo", capability: "generate_image", input: { prompt: "logo" } },
        { id: "hero", capability: "generate_image", input: { prompt: "hero" } },
        {
          id: "promo",
          capability: "generate_video",
          input: { prompt: "original promo prompt" },
        },
      ]),
    );

    expect(result.status).toBe("completed");
    // One checkpoint after the image batch (the trailing video batch has no
    // upcoming steps, so no second call).
    expect(reviewer).toHaveBeenCalledTimes(1);
    const checkpoint = reviewer.mock.calls[0]![0];
    expect(checkpoint.completedBatch.map((s) => s.stepId)).toEqual([
      "logo",
      "hero",
    ]);
    expect(checkpoint.upcoming).toEqual([
      {
        stepId: "promo",
        capability: "generate_video",
        prompt: "original promo prompt",
      },
    ]);
    expect(seenPrompts).toEqual(["revised promo prompt"]);
  });

  it("continues unchanged when the reviewer throws", async () => {
    executeMocks["generate_image"] = vi.fn(async () => ({ outputPath: "/a" }));
    executeMocks["generate_video"] = vi.fn(async (input) => ({
      outputPath: `/tmp/${input.prompt}`,
    }));
    setFlowReviewer(
      vi.fn(async () => {
        throw new Error("reviewer boom");
      }),
    );

    const result = await runFlow(
      makeIntent([
        { id: "img", capability: "generate_image", input: { prompt: "x" } },
        { id: "vid", capability: "generate_video", input: { prompt: "y" } },
      ]),
    );

    expect(result.status).toBe("completed");
    expect(executeMocks["generate_video"]).toHaveBeenCalledWith(
      { prompt: "y" },
      expect.anything(),
    );
  });
});

describe("resumeFlow", () => {
  it("keeps successful steps and re-runs failed ones under the same flow id", async () => {
    executeMocks["generate_image"] = vi.fn(async () => ({
      outputPath: "/tmp/hero.png",
    }));
    let audioAttempts = 0;
    executeMocks["generate_audio"] = vi.fn(async () => {
      audioAttempts += 1;
      if (audioAttempts === 1) throw new Error("audio boom");
      return { outputPath: "/tmp/voice.wav" };
    });
    executeMocks["build_app"] = vi.fn(async (_input, ctx) => ({
      prior: Object.keys(ctx.priorOutputs).sort(),
    }));

    const intent = makeIntent([
      { id: "img", capability: "generate_image", input: { prompt: "x" } },
      { id: "aud", capability: "generate_audio", input: { prompt: "y" } },
      {
        id: "build",
        capability: "build_app",
        input: {},
        dependsOn: ["img", "aud"],
      },
    ]);

    const first = await runFlow(intent);
    expect(first.status).toBe("partial");
    expect(first.steps.map((s) => s.status)).toEqual([
      "success",
      "failed",
      "skipped",
    ]);

    const resumed = await resumeFlow(first.flowId);
    expect(resumed.flowId).toBe(first.flowId);
    expect(resumed.status).toBe("completed");
    expect(resumed.steps.map((s) => s.status)).toEqual([
      "success",
      "success",
      "success",
    ]);
    // The image step was NOT re-executed; its prior output was re-threaded.
    expect(executeMocks["generate_image"]).toHaveBeenCalledTimes(1);
    expect(executeMocks["generate_audio"]).toHaveBeenCalledTimes(2);
    expect(resumed.steps[2].output.prior).toEqual(["aud", "img"]);
    // The original run's start time is preserved across the resume.
    expect(resumed.startedAt).toBe(first.startedAt);
  });

  it("throws for an unknown flow id", async () => {
    await expect(resumeFlow("no-such-flow")).rejects.toThrow(
      /No persisted flow run/,
    );
  });
});

describe("parallel execution (maxParallel > 1)", () => {
  it("runs independent steps concurrently while honoring dependencies", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const track = async <T>(fn: () => Promise<T>): Promise<T> => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return fn();
    };

    const buildSeenAt: { value: number } = { value: 0 };
    executeMocks["generate_image"] = vi.fn(() =>
      track(async () => ({ outputPath: "/tmp/a.png" })),
    );
    executeMocks["generate_video"] = vi.fn(() =>
      track(async () => ({ outputPath: "/tmp/b.mp4" })),
    );
    executeMocks["build_app"] = vi.fn(async (_input, ctx) => {
      buildSeenAt.value = Object.keys(ctx.priorOutputs).length;
      return { missionId: 1 };
    });

    const result = await runFlow(
      makeIntent([
        { id: "img", capability: "generate_image", input: { prompt: "x" } },
        { id: "vid", capability: "generate_video", input: { prompt: "y" } },
        {
          id: "build",
          capability: "build_app",
          input: {},
          dependsOn: ["img", "vid"],
        },
      ]),
      { maxParallel: 2 },
    );

    expect(result.status).toBe("completed");
    expect(peakInFlight).toBe(2); // img + vid overlapped
    expect(buildSeenAt.value).toBe(2); // build only ran after both finished
  });

  it("skips dependents of failed steps and reports partial", async () => {
    executeMocks["generate_image"] = vi.fn(async () => {
      throw new Error("gen boom");
    });
    executeMocks["generate_video"] = vi.fn(async () => ({
      outputPath: "/b",
    }));
    executeMocks["build_app"] = vi.fn(async () => ({ missionId: 1 }));

    const result = await runFlow(
      makeIntent([
        { id: "img", capability: "generate_image", input: { prompt: "x" } },
        { id: "vid", capability: "generate_video", input: { prompt: "y" } },
        {
          id: "build",
          capability: "build_app",
          input: {},
          dependsOn: ["img"],
        },
      ]),
      { maxParallel: 2 },
    );

    expect(result.status).toBe("partial");
    const byId = new Map(result.steps.map((s) => [s.stepId, s.status]));
    expect(byId.get("img")).toBe("failed");
    expect(byId.get("vid")).toBe("success");
    expect(byId.get("build")).toBe("skipped");
    expect(executeMocks["build_app"]).not.toHaveBeenCalled();
  });

  it("runs the review checkpoint once per wave with pending steps", async () => {
    executeMocks["generate_image"] = vi.fn(async () => ({
      outputPath: "/a.png",
    }));
    const videoPrompts: string[] = [];
    executeMocks["generate_video"] = vi.fn(async (input) => {
      videoPrompts.push(input.prompt);
      return { outputPath: "/b.mp4" };
    });

    const reviewer = vi.fn(async (_cp: FlowReviewCheckpoint) => ({
      promptRevisions: { vid: "revised video prompt" },
    }));
    setFlowReviewer(reviewer);

    const result = await runFlow(
      makeIntent([
        { id: "img", capability: "generate_image", input: { prompt: "x" } },
        {
          id: "vid",
          capability: "generate_video",
          input: { prompt: "original video prompt" },
          dependsOn: ["img"],
        },
      ]),
      { maxParallel: 2 },
    );

    expect(result.status).toBe("completed");
    expect(reviewer).toHaveBeenCalledTimes(1); // wave 2 has no pending steps
    expect(videoPrompts).toEqual(["revised video prompt"]);
  });
});

describe("swap telemetry", () => {
  it("attaches per-step swap events and aggregates flow totals", async () => {
    const gate = getModelGate();
    gate.setHooks({
      load: async () => {},
      unload: async () => {},
    });

    executeMocks["generate_image"] = vi.fn(() =>
      gate.with(
        { kind: "image", modelId: "test-image", vramMb: 512 },
        async () => ({ outputPath: "/tmp/a.png" }),
      ),
    );
    executeMocks["build_app"] = vi.fn(async () => ({ missionId: 1 }));

    const result = await runFlow(
      makeIntent([
        { id: "img", capability: "generate_image", input: { prompt: "x" } },
        { id: "build", capability: "build_app", input: {} },
      ]),
    );

    expect(result.status).toBe("completed");
    const imgStep = result.steps[0];
    expect(imgStep.swaps?.map((s) => s.kind)).toEqual(["load"]);
    expect(imgStep.swaps?.[0].key).toBe("image:test-image");
    // The following CPU-only build step evicts the preceding media model.
    expect(result.steps[1].swaps?.map((s) => s.kind)).toEqual(["unload"]);
    expect(result.swapTotals?.count).toBe(2);
  });
});
