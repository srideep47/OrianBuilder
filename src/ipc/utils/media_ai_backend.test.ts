import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEDIA_AI_SERVER_URL,
  releaseAllMediaAiModels,
  releaseMediaAiForLlm,
  unloadMediaAiModel,
} from "./media_ai_backend";

describe("unloadMediaAiModel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests a cooperative all-model unload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(unloadMediaAiModel("all")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `${MEDIA_AI_SERVER_URL}/v1/models/unload`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model_type: "all" }),
      }),
    );
  });

  it("returns false so callers can use their hard-stop fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ ok: false }),
      }),
    );

    await expect(unloadMediaAiModel("video")).resolves.toBe(false);
  });

  it("confirms cooperative release before another model family can load", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(releaseAllMediaAiModels()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `${MEDIA_AI_SERVER_URL}/v1/models/unload`,
      expect.objectContaining({ body: JSON.stringify({ model_type: "all" }) }),
    );
  });

  it("performs the dedicated hard LLM handoff after cooperative unload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(releaseMediaAiForLlm()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `${MEDIA_AI_SERVER_URL}/v1/models/unload`,
      expect.objectContaining({ body: JSON.stringify({ model_type: "all" }) }),
    );
  });
});
