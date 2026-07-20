import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: {
    modelPath: "D:/models/chat.gguf",
    gpuLayers: 20,
    actualContextSize: 8192,
  },
  unloadModel: vi.fn(),
  releaseMedia: vi.fn(),
  informAcquired: vi.fn(),
  informReleased: vi.fn(),
  acquireLlm: vi.fn(),
}));

vi.mock("./embedded_inference_server", () => ({
  getServerStatus: () => mocks.status,
  unloadModel: mocks.unloadModel,
}));
vi.mock("./media_ai_backend", () => ({
  releaseAllMediaAiModels: mocks.releaseMedia,
}));
vi.mock("@/main/ipc/utils/model_orchestrator", () => ({
  getOrchestrator: () => ({
    informLlmAcquired: mocks.informAcquired,
    informLlmReleased: mocks.informReleased,
    acquireLlm: mocks.acquireLlm,
  }),
}));

import {
  _resetExclusiveMediaSessionForTests,
  beginExclusiveMediaSession,
  endExclusiveMediaSession,
} from "./exclusive_model_residency";

describe("exclusive media residency session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.unloadModel.mockResolvedValue(undefined);
    mocks.releaseMedia.mockResolvedValue(undefined);
    mocks.acquireLlm.mockResolvedValue(undefined);
    _resetExclusiveMediaSessionForTests();
  });

  it("unloads the resident LLM, releases media, then restores that LLM", async () => {
    await beginExclusiveMediaSession();
    await endExclusiveMediaSession();

    expect(mocks.unloadModel).toHaveBeenCalledOnce();
    expect(mocks.informReleased).toHaveBeenCalledOnce();
    expect(mocks.releaseMedia).toHaveBeenCalledOnce();
    expect(mocks.acquireLlm).toHaveBeenCalledWith({
      modelPath: "D:/models/chat.gguf",
      gpuLayers: 20,
      contextSize: 8192,
    });
  });

  it("keeps one shared lease until the final nested session ends", async () => {
    await beginExclusiveMediaSession();
    await beginExclusiveMediaSession();
    await endExclusiveMediaSession();

    expect(mocks.releaseMedia).not.toHaveBeenCalled();
    expect(mocks.acquireLlm).not.toHaveBeenCalled();

    await endExclusiveMediaSession();
    expect(mocks.releaseMedia).toHaveBeenCalledOnce();
    expect(mocks.acquireLlm).toHaveBeenCalledOnce();
  });
});
