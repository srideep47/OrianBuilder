import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useVoiceAssistant } from "@/hooks/useVoiceAssistant";
import { VoiceState } from "@/lib/voiceAssistant";

const { transcribeAudioMock } = vi.hoisted(() => ({
  transcribeAudioMock: vi.fn(),
}));

vi.mock("@/ipc/types", () => ({
  ipc: {
    audio: {
      transcribeAudio: transcribeAudioMock,
    },
  },
}));

describe("useVoiceAssistant", () => {
  let trackStopMock: ReturnType<typeof vi.fn>;

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

  beforeEach(() => {
    transcribeAudioMock.mockReset();
    trackStopMock = vi.fn();

    const stream = {
      getTracks: () => [{ stop: trackStopMock }],
    } as unknown as MediaStream;

    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
      },
      configurable: true,
    });

    let mediaRecorderInstance: MockMediaRecorder | null = null;

    Object.defineProperty(globalThis, "MediaRecorder", {
      value: function(stream: MediaStream) {
        const instance = new MockMediaRecorder();
        mediaRecorderInstance = instance;
        return instance;
      },
      configurable: true,
    });

    // Mock Web Speech API
    Object.defineProperty(globalThis.window, "speechSynthesis", {
      value: {
        speak: vi.fn(),
        cancel: vi.fn(),
      },
      configurable: true,
    });

    // Mock SpeechSynthesisUtterance
    Object.defineProperty(globalThis.window, "SpeechSynthesisUtterance", {
      value: function (text: string) {
        return {
          text,
          rate: 1,
          pitch: 1,
          lang: "en-US",
          onend: null,
          onerror: null,
        };
      },
      configurable: true,
    });

    // Store reference to trigger ondataavailable
    (globalThis as any)._currentMediaRecorder = () => mediaRecorderInstance;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should initialize with idle state", () => {
    const { result } = renderHook(() =>
      useVoiceAssistant({
        enabled: true,
      }),
    );

    expect(result.current.context.state).toBe(VoiceState.IDLE);
    expect(result.current.isRecording).toBe(false);
    expect(result.current.isTranscribing).toBe(false);
    expect(result.current.isSpeaking).toBe(false);
  });

  it("should start recording when toggleRecording is called", async () => {
    const { result } = renderHook(() =>
      useVoiceAssistant({
        enabled: true,
      }),
    );

    await act(async () => {
      await result.current.toggleRecording();
    });

    expect(result.current.isRecording).toBe(true);
    expect(result.current.context.state).toBe(VoiceState.LISTENING);
  });

  it("should handle successful transcription", async () => {
    const onTranscription = vi.fn();
    transcribeAudioMock.mockResolvedValue({
      text: "hello world",
    });

    const { result } = renderHook(() =>
      useVoiceAssistant({
        enabled: true,
        onTranscription,
      }),
    );

    await act(async () => {
      await result.current.toggleRecording();
    });

    // Trigger ondataavailable to send mock audio data
    const recorder = (globalThis as any)._currentMediaRecorder();
    if (recorder?.ondataavailable) {
      recorder.ondataavailable({ data: new Blob(["audio"], { type: "audio/webm" }) });
    }

    // Stop recording
    await act(async () => {
      await result.current.toggleRecording();
    });

    // Wait for async operations
    await waitFor(() => {
      expect(result.current.isTranscribing).toBe(false);
    });

    expect(onTranscription).toHaveBeenCalledWith("hello world");
    expect(result.current.context.userText).toBe("hello world");
  });

  it("should generate assistant reply after transcription", async () => {
    transcribeAudioMock.mockResolvedValue({
      text: "hello",
    });

    const { result } = renderHook(() =>
      useVoiceAssistant({
        enabled: true,
      }),
    );

    await act(async () => {
      await result.current.toggleRecording();
    });

    // Trigger ondataavailable to send mock audio data
    const recorder = (globalThis as any)._currentMediaRecorder();
    if (recorder?.ondataavailable) {
      recorder.ondataavailable({ data: new Blob(["audio"], { type: "audio/webm" }) });
    }

    await act(async () => {
      await result.current.toggleRecording();
    });

    await waitFor(() => {
      expect(result.current.isTranscribing).toBe(false);
    });

    expect(result.current.context.assistantText).toContain("Hello");
  });

  it("should clear conversation", async () => {
    const { result } = renderHook(() =>
      useVoiceAssistant({
        enabled: true,
      }),
    );

    // Set some context
    await act(async () => {
      await result.current.toggleRecording();
    });

    // Clear
    await act(async () => {
      result.current.clearConversation();
    });

    expect(result.current.context.userText).toBe("");
    expect(result.current.context.assistantText).toBe("");
    expect(result.current.context.state).toBe(VoiceState.IDLE);
  });

  it("should stop all audio", async () => {
    const { result } = renderHook(() =>
      useVoiceAssistant({
        enabled: true,
      }),
    );

    await act(async () => {
      await result.current.toggleRecording();
    });

    expect(result.current.isRecording).toBe(true);

    await act(async () => {
      result.current.stopAllAudio();
    });

    expect(result.current.isRecording).toBe(false);
    expect(result.current.context.state).toBe(VoiceState.IDLE);
  });

  it("should handle transcription errors", async () => {
    const onError = vi.fn();
    transcribeAudioMock.mockRejectedValue(new Error("Transcription failed"));

    const { result } = renderHook(() =>
      useVoiceAssistant({
        enabled: true,
        onError,
      }),
    );

    await act(async () => {
      await result.current.toggleRecording();
    });

    // Trigger ondataavailable to send mock audio data
    const recorder = (globalThis as any)._currentMediaRecorder();
    if (recorder?.ondataavailable) {
      recorder.ondataavailable({ data: new Blob(["audio"], { type: "audio/webm" }) });
    }

    await act(async () => {
      await result.current.toggleRecording();
    });

    await waitFor(() => {
      expect(result.current.isTranscribing).toBe(false);
    });

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Transcription"));
  });

  it("should handle empty transcription", async () => {
    transcribeAudioMock.mockResolvedValue({
      text: "",
    });

    const { result } = renderHook(() =>
      useVoiceAssistant({
        enabled: true,
      }),
    );

    await act(async () => {
      await result.current.toggleRecording();
    });

    // Trigger ondataavailable to send mock audio data
    const recorder = (globalThis as any)._currentMediaRecorder();
    if (recorder?.ondataavailable) {
      recorder.ondataavailable({ data: new Blob(["audio"], { type: "audio/webm" }) });
    }

    await act(async () => {
      await result.current.toggleRecording();
    });

    await waitFor(() => {
      expect(result.current.isTranscribing).toBe(false);
    });

    expect(result.current.context.userText).toBe("");
  });

  it("should not start recording if disabled", async () => {
    const { result } = renderHook(() =>
      useVoiceAssistant({
        enabled: false,
      }),
    );

    await act(async () => {
      await result.current.toggleRecording();
    });

    expect(result.current.isRecording).toBe(false);
  });
});
