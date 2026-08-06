import { describe, expect, it, vi } from "vitest";

import { createWhisperAsrBackend } from "./asr";

describe("createWhisperAsrBackend", () => {
  it("qualifies the endpointed browser backend and emits its final result", async () => {
    const onTranscript = vi.fn();
    const backend = createWhisperAsrBackend({
      getModelStatus: () => "ready",
      getModelLoadProgress: () => 100,
      warmUp: vi.fn(),
      transcribe: async () => "  show the first task  ",
      now: () => 42,
    });

    expect(backend.getHealth()).toMatchObject({
      status: "ready",
      supportsStreaming: false,
      supportsCancellation: false,
      checkedAt: 42,
    });
    await expect(
      backend.transcribe(new Blob(["audio"]), { onTranscript }),
    ).resolves.toEqual({ text: "show the first task", final: true });
    expect(onTranscript).toHaveBeenCalledWith({
      text: "show the first task",
      final: true,
    });
  });

  it("discards an in-flight result immediately after cancellation", async () => {
    let finish!: (text: string) => void;
    const backend = createWhisperAsrBackend({
      getModelStatus: () => "loading",
      getModelLoadProgress: () => 37,
      warmUp: vi.fn(),
      transcribe: () => new Promise<string>((resolve) => (finish = resolve)),
    });
    const controller = new AbortController();
    const result = backend.transcribe(new Blob(["audio"]), {
      signal: controller.signal,
    });

    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    // The WASM call itself is not cancellable, but its eventual completion is
    // handled and cannot leak into the next turn.
    finish("stale words");
    await Promise.resolve();
  });
});
