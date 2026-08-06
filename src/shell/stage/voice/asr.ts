import type { VoiceBackendHealth } from "./runtime";

export interface AsrTranscriptUpdate {
  text: string;
  final: boolean;
  stability?: number;
}

export interface AsrTranscriptionOptions {
  signal?: AbortSignal;
  onTranscript?: (update: AsrTranscriptUpdate) => void;
}

export interface AsrBackend {
  getHealth(): VoiceBackendHealth;
  warmUp(): void | Promise<void>;
  transcribe(
    audio: Blob,
    options?: AsrTranscriptionOptions,
  ): Promise<AsrTranscriptUpdate>;
  subscribe?(listener: () => void): () => void;
}

export type WhisperModelStatus = "unloaded" | "loading" | "ready";

export interface WhisperAsrAdapter {
  getModelStatus: () => WhisperModelStatus;
  getModelLoadProgress: () => number;
  warmUp: () => void;
  transcribe: (audio: Blob) => Promise<string>;
  now?: () => number;
}

function abortError(): DOMException {
  return new DOMException("Speech recognition was cancelled.", "AbortError");
}

/**
 * Adapt the existing local Transformers.js Whisper hook to the backend seam.
 *
 * Whisper-tiny is endpointed rather than streaming, so it emits one final
 * update. The contract already admits partials and cooperative cancellation,
 * allowing a native streaming ASR backend to replace it later.
 */
export function createWhisperAsrBackend(
  adapter: WhisperAsrAdapter,
): AsrBackend {
  const now = adapter.now ?? Date.now;

  return {
    getHealth(): VoiceBackendHealth {
      const modelStatus = adapter.getModelStatus();
      const progress = adapter.getModelLoadProgress();
      return {
        descriptor: {
          id: "transformers-whisper-tiny-en",
          label: "Local Whisper Tiny (browser)",
          kind: "asr",
          execution: "browser",
          model: "Xenova/whisper-tiny.en",
        },
        status:
          modelStatus === "ready"
            ? "ready"
            : modelStatus === "loading"
              ? "warming"
              : "cold",
        detail:
          modelStatus === "loading"
            ? `Preparing local speech recognition (${progress}%).`
            : undefined,
        supportsStreaming: false,
        // The current WASM inference cannot be stopped once it enters ONNX.
        // Results are discarded immediately on abort, but compute may finish.
        supportsCancellation: false,
        checkedAt: now(),
      };
    },

    warmUp(): void {
      adapter.warmUp();
    },

    async transcribe(
      audio: Blob,
      options: AsrTranscriptionOptions = {},
    ): Promise<AsrTranscriptUpdate> {
      if (options.signal?.aborted) throw abortError();

      const text = await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener("abort", onAbort);
          fn();
        };
        const onAbort = () => finish(() => reject(abortError()));
        options.signal?.addEventListener("abort", onAbort, { once: true });

        void adapter.transcribe(audio).then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
      });

      const update = { text: text.trim(), final: true } as const;
      options.onTranscript?.(update);
      return update;
    },
  };
}
