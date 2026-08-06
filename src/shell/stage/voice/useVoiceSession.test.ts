import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AsrBackend, AsrTranscriptionOptions } from "./asr";
import type { MicSessionOptions, VoiceCaptureSession } from "./mic_session";
import {
  CLOSED_MICROPHONE_HEALTH,
  type MicrophoneHealth,
  type VoiceBackendDescriptor,
  type VoiceBackendHealth,
} from "./runtime";
import type { TtsEngine } from "./tts";
import { DEFAULT_TUNING } from "./turn_taking";
import { useVoiceSession } from "./useVoiceSession";

vi.mock("@/hooks/useWhisperTranscription", () => ({
  useWhisperTranscription: () => ({
    modelStatus: "ready" as const,
    modelLoadProgress: 100,
    isTranscribing: false,
    warmUp: vi.fn(),
    transcribe: vi.fn(async () => ""),
  }),
}));

class FakeMic implements VoiceCaptureSession {
  readonly sampleRate = 48_000;
  isOpen = false;
  capturedFrames = 0;
  readonly isBargeInSafe = true;
  closeCalls = 0;
  private health: MicrophoneHealth = { ...CLOSED_MICROPHONE_HEALTH };

  constructor(
    private readonly options: MicSessionOptions,
    private readonly openGate?: Promise<void>,
  ) {}

  getHealth(): MicrophoneHealth {
    return { ...this.health };
  }
  async open(): Promise<void> {
    this.health = { ...this.health, state: "opening" };
    this.options.onHealthChange?.(this.getHealth());
    await this.openGate;
    this.isOpen = true;
    this.health = {
      state: "open",
      echoControl: "active",
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48_000,
      checkedAt: 1,
    };
    this.options.onHealthChange?.(this.getHealth());
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.isOpen = false;
    this.health = { ...CLOSED_MICROPHONE_HEALTH, checkedAt: 2 };
    this.options.onHealthChange?.(this.getHealth());
  }
  startCapture(): void {
    this.capturedFrames = 10;
  }
  discardCapture(): void {
    this.capturedFrames = 0;
  }
  endCapture(): Blob | null {
    this.capturedFrames = 0;
    return new Blob(["audio"], { type: "audio/wav" });
  }
  emit(frame: Float32Array): void {
    this.options.onFrame(frame);
  }
}

class FakeAsr implements AsrBackend {
  readonly signals: AbortSignal[] = [];
  warmUp = vi.fn();
  getHealth(): VoiceBackendHealth {
    return {
      descriptor: {
        id: "fake-asr",
        label: "Fake streaming ASR",
        kind: "asr",
        execution: "local-process",
      },
      status: "ready",
      supportsStreaming: true,
      supportsCancellation: true,
      checkedAt: 1,
    };
  }
  async transcribe(_audio: Blob, options: AsrTranscriptionOptions = {}) {
    if (options.signal) this.signals.push(options.signal);
    const result = { text: "hello Marta", final: true } as const;
    options.onTranscript?.(result);
    return result;
  }
}

class HangingTts implements TtsEngine {
  readonly descriptor: VoiceBackendDescriptor = {
    id: "fake-tts",
    label: "Fake TTS",
    kind: "tts",
    execution: "local-process",
  };
  cancel = vi.fn();
  isAvailable(): boolean {
    return true;
  }
  getHealth(): VoiceBackendHealth {
    return {
      descriptor: this.descriptor,
      status: "ready",
      supportsStreaming: true,
      supportsCancellation: true,
      checkedAt: 1,
    };
  }
  speak(_text: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    return new Promise((resolve) => {
      options.signal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }
  isSpeaking(): boolean {
    return true;
  }
}

const frame = (speech: boolean): Float32Array => {
  const result = new Float32Array(512);
  if (!speech) return result;
  for (let index = 0; index < result.length; index++) {
    result[index] = 0.1 * Math.sin((2 * Math.PI * 140 * index) / 16_000);
  }
  return result;
};

describe("useVoiceSession", () => {
  it("remains live after React StrictMode's simulated cleanup", async () => {
    let mic!: FakeMic;
    const { result } = renderHook(
      () =>
        useVoiceSession({
          onUtterance: vi.fn(async () => ""),
          asrBackend: new FakeAsr(),
          ttsEngine: new HangingTts(),
          createMicSession: (options) => (mic = new FakeMic(options)),
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(StrictMode, null, children),
      },
    );

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.phase).toBe("listening"));
    expect(mic.isOpen).toBe(true);
  });

  it("converges on off when toggled off before permission resolves", async () => {
    let finishOpen!: () => void;
    const gate = new Promise<void>((resolve) => (finishOpen = resolve));
    let mic!: FakeMic;
    const { result } = renderHook(() =>
      useVoiceSession({
        onUtterance: vi.fn(async () => ""),
        asrBackend: new FakeAsr(),
        ttsEngine: new HangingTts(),
        createMicSession: (options) => (mic = new FakeMic(options, gate)),
      }),
    );

    act(() => result.current.toggle());
    act(() => result.current.toggle());
    finishOpen();

    await waitFor(() => expect(mic.closeCalls).toBeGreaterThan(0));
    expect(result.current.phase).toBe("off");
    expect(result.current.enabled).toBe(false);
  });

  it("cancels speech and the model turn when sustained speech barges in", async () => {
    const asr = new FakeAsr();
    const tts = new HangingTts();
    const cancelTurn = vi.fn();
    const transcriptUpdate = vi.fn();
    let mic!: FakeMic;
    const { result } = renderHook(() =>
      useVoiceSession({
        onUtterance: async (_text, callbacks) => {
          callbacks.onTextDelta("I am still working on that.");
          return "I am still working on that.";
        },
        onCancelTurn: cancelTurn,
        onTranscriptUpdate: transcriptUpdate,
        asrBackend: asr,
        ttsEngine: tts,
        createMicSession: (options) => (mic = new FakeMic(options)),
      }),
    );

    act(() => result.current.toggle());
    await waitFor(() => expect(result.current.phase).toBe("listening"));
    act(() => {
      for (let index = 0; index < DEFAULT_TUNING.onsetFrames; index++) {
        mic.emit(frame(true));
      }
      for (let index = 0; index < DEFAULT_TUNING.endpointFrames; index++) {
        mic.emit(frame(false));
      }
    });
    await waitFor(() => expect(result.current.phase).toBe("speaking"));
    expect(transcriptUpdate).toHaveBeenCalledWith({
      text: "hello Marta",
      final: true,
    });

    act(() => {
      for (let index = 0; index < DEFAULT_TUNING.bargeInFrames; index++) {
        mic.emit(frame(true));
      }
    });
    await waitFor(() => expect(result.current.phase).toBe("capturing"));
    expect(result.current.interrupted).toBe(true);
    expect(cancelTurn).toHaveBeenCalledTimes(1);
    expect(tts.cancel).toHaveBeenCalled();
  });
});
