import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowContext } from "./capability_registry";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  releaseIdle: vi.fn(),
  dispatchMediaGeneration: vi.fn(),
  initMediaDispatcher: vi.fn(),
  getStatus: vi.fn(),
  runMediaGeneration: vi.fn(),
}));

vi.mock("@/main/flow/model_lease", () => ({
  getModelLeaseManager: () => ({
    acquire: mocks.acquire,
    releaseIdle: mocks.releaseIdle,
  }),
}));

vi.mock("@/main/ipc/utils/media_dispatcher", () => ({
  dispatchMediaGeneration: mocks.dispatchMediaGeneration,
  initMediaDispatcher: mocks.initMediaDispatcher,
}));

vi.mock("@/main/ipc/utils/model_orchestrator", () => ({
  getOrchestrator: () => ({
    getStatus: mocks.getStatus,
    runMediaGeneration: mocks.runMediaGeneration,
  }),
}));

import { getCapability } from "./capability_registry";

function makeCtx(): FlowContext {
  return {
    goal: "Build a coffee brand landing page",
    mediaDir: os.tmpdir(),
    priorOutputs: {},
  };
}

beforeEach(() => {
  mocks.acquire.mockReset();
  mocks.release.mockReset();
  mocks.releaseIdle.mockReset();
  mocks.dispatchMediaGeneration.mockReset();
  mocks.initMediaDispatcher.mockReset();
  mocks.getStatus.mockReset();
  mocks.runMediaGeneration.mockReset();

  mocks.acquire.mockResolvedValue({
    key: "media:image",
    release: mocks.release,
  });
  mocks.releaseIdle.mockResolvedValue(undefined);
  mocks.getStatus.mockReturnValue({ state: "idle" });
});

describe("capability registry", () => {
  it("runs media dispatcher fallback when a model lease cannot fit in VRAM", async () => {
    mocks.acquire.mockRejectedValueOnce(
      new Error(
        'Cannot fit model "media:image" (4096 MB): insufficient VRAM even after eviction.',
      ),
    );
    mocks.dispatchMediaGeneration.mockResolvedValueOnce({
      success: true,
      outputPath: "C:\\tmp\\coffee-logo.png",
      durationMs: 12,
    });

    const output = await getCapability("generate_image").execute(
      { prompt: "coffee logo" },
      makeCtx(),
    );

    expect(mocks.dispatchMediaGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        modelType: "image",
        prompt: "coffee logo",
      }),
    );
    expect(output).toEqual({
      outputPath: "C:\\tmp\\coffee-logo.png",
      durationMs: 12,
      modelType: "image",
    });
  });

  it("returns setupRequired for unavailable video backends without failing the step", async () => {
    mocks.acquire.mockRejectedValueOnce(
      new Error(
        'Cannot fit model "media:video" (8192 MB): insufficient VRAM even after eviction.',
      ),
    );
    mocks.dispatchMediaGeneration.mockResolvedValueOnce({
      success: false,
      outputPath: "C:\\tmp\\promo.mp4",
      durationMs: 5,
      error: "video backend is not running",
    });

    const output = await getCapability("generate_video").execute(
      { prompt: "promo video" },
      makeCtx(),
    );

    expect(output).toMatchObject({
      setupRequired: true,
      setupRoute: "/mediaai",
      reason: "video backend is not running",
      modelType: "video",
      prompt: "promo video",
    });
    expect(output.outputPath).toBeUndefined();
  });
});
