import { afterEach, describe, expect, it, vi } from "vitest";
import { runBackendMediaJob } from "./media_backend_jobs";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runBackendMediaJob", () => {
  it("reports changing backend stages and returns the completed result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ job_id: "job-progress" }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "job-progress",
          kind: "image",
          status: "running",
          stage: "Loading model",
          progress: 0.2,
          result: null,
          error: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "job-progress",
          kind: "image",
          status: "done",
          stage: "Saving image",
          progress: 1,
          result: { image_url: "/outputs/result.png" },
          error: null,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn();

    const result = await runBackendMediaJob(
      "image",
      { prompt: "sunrise" },
      { pollIntervalMs: 1, onProgress },
    );

    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { stage: "Loading model", progress: 0.2 },
      { stage: "Saving image", progress: 1 },
    ]);
    expect(result).toEqual({ image_url: "/outputs/result.png" });
  });

  it("aborts an in-flight status request and cancels the backend job", async () => {
    const controller = new AbortController();
    let rejectStatus: ((reason?: unknown) => void) | undefined;
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
      const address = String(url);
      if (address.endsWith("/v1/jobs")) {
        return Promise.resolve(jsonResponse({ job_id: "job-cancel" }));
      }
      if (address.endsWith("/job-cancel/cancel")) {
        return Promise.resolve(jsonResponse({ cancelled: true }));
      }
      return new Promise<Response>((_resolve, reject) => {
        rejectStatus = reject;
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const job = runBackendMediaJob(
      "image",
      { prompt: "sunrise" },
      { pollIntervalMs: 60_000, signal: controller.signal },
    );
    await vi.waitFor(() => expect(rejectStatus).toBeTypeOf("function"));
    controller.abort();

    await expect(job).rejects.toThrow("image generation was cancelled");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/job-cancel/cancel"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
