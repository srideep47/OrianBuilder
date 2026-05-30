import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSelectedEmbeddedModelReady } from "./embeddedModelAutoload";
import type { UserSettings } from "./schemas";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getSavedConfig: vi.fn(),
  loadModel: vi.fn(),
}));

vi.mock("@/ipc/types", () => ({
  ipc: {
    embeddedModel: {
      getStatus: mocks.getStatus,
      getSavedConfig: mocks.getSavedConfig,
      loadModel: mocks.loadModel,
    },
  },
}));

const { getStatus, getSavedConfig, loadModel } = mocks;

const baseSettings = {
  selectedModel: { provider: "embedded", name: "Local Engine" },
} as UserSettings;

describe("ensureSelectedEmbeddedModelReady", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("does nothing when the selected provider is not embedded", async () => {
    await ensureSelectedEmbeddedModelReady({
      ...baseSettings,
      selectedModel: { provider: "openai", name: "gpt-test" },
    });

    expect(getStatus).not.toHaveBeenCalled();
    expect(loadModel).not.toHaveBeenCalled();
  });

  it("does not reload an already-loaded embedded model", async () => {
    getStatus.mockResolvedValueOnce({ modelLoaded: true, isLoading: false });

    await ensureSelectedEmbeddedModelReady(baseSettings);

    expect(getSavedConfig).not.toHaveBeenCalled();
    expect(loadModel).not.toHaveBeenCalled();
  });

  it("loads the saved Engine config when embedded is selected and unloaded", async () => {
    getStatus.mockResolvedValueOnce({ modelLoaded: false, isLoading: false });
    getSavedConfig.mockResolvedValueOnce({
      modelPath: "D:/models/qwen.gguf",
      contextSize: 32768,
      temperature: 0.4,
    });
    loadModel.mockResolvedValueOnce({ success: true });

    await ensureSelectedEmbeddedModelReady(baseSettings);

    expect(loadModel).toHaveBeenCalledWith(
      expect.objectContaining({
        modelPath: "D:/models/qwen.gguf",
        inferenceBackend: "llama-cpp",
        contextSize: 32768,
        temperature: 0.4,
      }),
    );
  });

  it("fails clearly when no saved Engine model exists", async () => {
    getStatus.mockResolvedValueOnce({ modelLoaded: false, isLoading: false });
    getSavedConfig.mockResolvedValueOnce({ modelPath: null });

    await expect(
      ensureSelectedEmbeddedModelReady(baseSettings),
    ).rejects.toThrow("No saved Engine model is available");
    expect(loadModel).not.toHaveBeenCalled();
  });
});
