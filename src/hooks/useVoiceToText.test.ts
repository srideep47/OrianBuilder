import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useVoiceToText } from "@/hooks/useVoiceToText";

// ─── Mock the Whisper hook ────────────────────────────────────────────────────
// We stub the entire useWhisperTranscription module so tests don't touch the
// real Transformers.js pipeline, ONNX WASM, or AudioContext.
const { transcribeMock } = vi.hoisted(() => ({
  transcribeMock: vi.fn<(blob: Blob) => Promise<string>>(),
}));

vi.mock("@/hooks/useWhisperTranscription", () => ({
  useWhisperTranscription: () => ({
    modelStatus: "ready" as const,
    modelLoadProgress: 100,
    isTranscribing: false,
    warmUp: vi.fn(),
    transcribe: transcribeMock,
  }),
}));

// ─── Minimal MediaRecorder stub ───────────────────────────────────────────────
class MockMediaRecorder {
  public state: "inactive" | "recording" | "paused" = "inactive";
  public ondataavailable: ((event: { data: Blob }) => void) | null = null;
  public onstop: (() => void | Promise<void>) | null = null;

  public start = vi.fn(() => {
    this.state = "recording";
  });

  public stop = vi.fn(() => {
    this.state = "inactive";
    void this.onstop?.();
  });
}

describe("useVoiceToText", () => {
  let trackStopMock: ReturnType<typeof vi.fn>;
  let mediaRecorderInstances: MockMediaRecorder[];

  beforeEach(() => {
    transcribeMock.mockReset();
    mediaRecorderInstances = [];
    trackStopMock = vi.fn();

    const stream = {
      getTracks: () => [{ stop: trackStopMock }],
    } as unknown as MediaStream;

    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
      configurable: true,
    });

    Object.defineProperty(globalThis, "MediaRecorder", {
      value: vi.fn(() => {
        const instance = new MockMediaRecorder();
        mediaRecorderInstances.push(instance);
        return instance;
      }),
      configurable: true,
      writable: true,
    });
  });

  it("stops the active microphone stream when unmounted mid-recording", async () => {
    const onTranscription = vi.fn();

    const { result, unmount } = renderHook(() =>
      useVoiceToText({ enabled: true, onTranscription }),
    );

    await act(async () => {
      await result.current.toggleRecording();
    });

    expect(result.current.isRecording).toBe(true);

    unmount();

    expect(mediaRecorderInstances).toHaveLength(1);
    expect(mediaRecorderInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(trackStopMock).toHaveBeenCalledTimes(1);
    // transcribe() must NOT be called when recording is cancelled by unmount
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(onTranscription).not.toHaveBeenCalled();
  });

  it("still transcribes when recording is stopped by the user", async () => {
    // transcribe() now returns a plain string (not { text: string })
    transcribeMock.mockResolvedValue("hello world");
    const onTranscription = vi.fn();

    const { result } = renderHook(() =>
      useVoiceToText({ enabled: true, onTranscription }),
    );

    await act(async () => {
      await result.current.toggleRecording();
    });

    const recorder = mediaRecorderInstances[0];
    recorder.ondataavailable?.({
      data: new Blob(["test audio"], { type: "audio/webm" }),
    });

    await act(async () => {
      await result.current.toggleRecording();
    });

    await waitFor(() => {
      expect(transcribeMock).toHaveBeenCalledTimes(1);
    });

    expect(onTranscription).toHaveBeenCalledWith("hello world");
    expect(trackStopMock).toHaveBeenCalledTimes(1);
  });
});
