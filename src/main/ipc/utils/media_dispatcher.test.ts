import { describe, expect, it, vi } from "vitest";

vi.mock("./model_orchestrator", () => ({
  getOrchestrator: () => ({ setHooks: vi.fn() }),
  pickBestImageTier: vi.fn(),
  pickBestAudioTtsTier: vi.fn(),
  pickBestMusicTier: vi.fn(),
  pickBestVideoTier: vi.fn(),
  getLastLlmParams: vi.fn(),
  estimateFreedLlmVramMb: vi.fn(),
}));
vi.mock("./cloud_image_generator", () => ({ generateImageViaCloud: vi.fn() }));
vi.mock("./local_image_generator", () => ({
  generateImageViaLocalBackend: vi.fn(),
}));
vi.mock("./local_audio_generator", () => ({
  generateAudioViaLocalBackend: vi.fn(),
}));
vi.mock("./local_music_generator", () => ({
  generateMusicViaLocalBackend: vi.fn(),
}));
vi.mock("./local_video_generator", () => ({
  generateVideoViaLocalBackend: vi.fn(),
}));
vi.mock("./vram_accounting", () => ({ getAvailableVramMb: vi.fn() }));
vi.mock("./media_llm_guard", () => ({ ensureLlmSwapForMedia: vi.fn() }));
vi.mock("@/main/hardware/detect", () => ({
  getCachedHardwareProfile: vi.fn(),
}));
vi.mock("@/ipc/utils/media_ai_backend", () => ({
  downloadMediaAiModels: vi.fn(),
  getMediaAiBackendStatus: vi.fn(),
}));

import { resolveAvailableMediaTier } from "./media_dispatcher";

describe("resolveAvailableMediaTier", () => {
  it("uses a downloaded image alternative before downloading the requested tier", () => {
    expect(
      resolveAvailableMediaTier({
        modelType: "image",
        preferredTierId: "z-image-turbo",
        hardwareTierId: "z-image-turbo",
        downloadedModelIds: new Set(["image-sd-turbo"]),
      }),
    ).toEqual({ tierId: "sd-turbo", reason: "installed alternative" });
  });

  it("downloads the hardware-selected tier when no compatible model exists", () => {
    expect(
      resolveAvailableMediaTier({
        modelType: "image",
        preferredTierId: "z-image-turbo",
        hardwareTierId: "sd-turbo",
        downloadedModelIds: new Set(),
      }),
    ).toEqual({
      tierId: "sd-turbo",
      downloadId: "image-sd-turbo",
      reason: "best tier for this hardware",
    });
  });

  it("keeps the requested tier when it is already downloaded", () => {
    expect(
      resolveAvailableMediaTier({
        modelType: "image",
        preferredTierId: "z-image-turbo",
        hardwareTierId: "sd-turbo",
        downloadedModelIds: new Set(["image-z-image-turbo"]),
      }),
    ).toEqual({
      tierId: "z-image-turbo",
      reason: "requested tier is installed",
    });
  });

  it("uses the hardware tier backed by downloaded video weights", () => {
    expect(
      resolveAvailableMediaTier({
        modelType: "video",
        preferredTierId: "wan-2.2-i2v",
        hardwareTierId: "animatediff-sd15-small",
        downloadedModelIds: new Set(["video"]),
      }),
    ).toEqual({
      tierId: "animatediff-sd15-small",
      reason: "installed alternative",
    });
  });
});
