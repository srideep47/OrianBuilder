/**
 * useWhisperTranscription
 *
 * Fully local, browser-based speech-to-text using Transformers.js + Whisper.
 * No IPC, no cloud API keys, no Electron main-process involvement.
 *
 * Model: Xenova/whisper-tiny.en  (~150 MB fp32, cached in IndexedDB after first download)
 * Audio: WebM/Opus blob → PCM Float32 16 kHz mono → Whisper pipeline
 *
 * NOTE: fp32 weights are used instead of q8 to avoid an ONNX Runtime bug where
 * DequantizeLinear nodes for MatMulNBits are missing their required scale tensors,
 * which causes a fatal "Can't create a session" crash at model load time.
 */

import { useCallback, useRef, useState } from "react";
import { pipeline, env } from "@huggingface/transformers";

// ─── Transformers.js environment ─────────────────────────────────────────────
// Disable local model resolution so models are always fetched from the
// HuggingFace Hub CDN. After the first download they are stored in
// IndexedDB (browser cache), so subsequent loads are instant and offline.
env.allowLocalModels = false;

// ─── Constants ────────────────────────────────────────────────────────────────
const MODEL_ID = "Xenova/whisper-tiny.en";

// Whisper was trained on 16 kHz mono audio — do not change this.
const WHISPER_SAMPLE_RATE = 16_000;

// ─── Hallucination prefix filter ──────────────────────────────────────────────
// Whisper-tiny.en commonly inserts these phrases as a spurious prefix before
// (or instead of) real speech.  Strip any leading sentences that match.
const HALLUCINATION_PHRASES = new Set([
  "i'm gonna hide.",
  "i'm gonna hide",
  "thank you.",
  "thank you",
  "thank you for watching.",
  "thank you for watching",
  "thanks for watching.",
  "thanks for watching",
  "you",
  "okay.",
  "okay",
  "alright.",
  "alright",
  "so.",
  "so,",
  "hmm.",
  "hmm",
  "uh.",
  "uh,",
  "um.",
  "um,",
  ".",
  "",
]);

function stripHallucinationPrefix(text: string): string {
  // Split on sentence boundaries, remove leading sentences that are known noise.
  const sentences = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  while (sentences.length > 0) {
    if (HALLUCINATION_PHRASES.has(sentences[0].trim().toLowerCase())) {
      sentences.shift();
    } else {
      break;
    }
  }
  return sentences.join("").trim();
}

// ─── Module-level pipeline singleton ─────────────────────────────────────────
// Stored outside React so the model is initialised exactly once per app
// session, even if many components mount or unmount.
type ASRPipeline = Awaited<ReturnType<typeof pipeline>>;
let _pipe: ASRPipeline | null = null;
let _loadPromise: Promise<ASRPipeline> | null = null;

type ProgressCallback = (pct: number) => void;

async function acquirePipeline(
  onProgress?: ProgressCallback,
): Promise<ASRPipeline> {
  if (_pipe) return _pipe;

  // If a load is already in flight, attach to it rather than starting another.
  if (_loadPromise) return _loadPromise;

  _loadPromise = pipeline("automatic-speech-recognition", MODEL_ID, {
    // Force WASM backend — WebGPU is unstable on Windows/Electron and produces
    // garbage output (silence → hallucinations) that fools the guards.
    // WASM is slightly slower but gives accurate, consistent results.
    device: "wasm",
    // fp32 weights avoid the ONNX Runtime DequantizeLinear crash (qdq_actions.cc:137).
    dtype: {
      encoder_model: "fp32",
      decoder_model_merged: "fp32",
    },
    progress_callback: (info: { status: string; progress?: number }) => {
      if (info.status === "progress" && typeof info.progress === "number") {
        onProgress?.(info.progress);
      }
    },
  } as Parameters<typeof pipeline>[2]).then((p) => {
    _pipe = p as ASRPipeline;
    _loadPromise = null;
    return _pipe;
  });

  return _loadPromise;
}

// ─── Audio decoding & resampling ──────────────────────────────────────────────

/**
 * Convert a MediaRecorder Blob (WebM/Opus) into a mono Float32Array at
 * 16 kHz, which is the exact format Whisper expects.
 *
 * Uses only standard Web Audio APIs — no external libraries, no blocking code:
 *   1. AudioContext.decodeAudioData  → codec decode (hardware-accelerated)
 *   2. OfflineAudioContext           → sample-rate conversion + mono downmix
 */
export async function blobToWhisperAudio(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();

  // Decode at the file's native sample rate (usually 48 kHz for WebM/Opus).
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } finally {
    // Always release the AudioContext so we don't exhaust the OS limit.
    await decodeCtx.close();
  }

  // Fast path: already mono 16 kHz.
  // Re-cast via new Float32Array() to move the buffer into the local JS realm —
  // Electron context isolation causes the cross-realm Float32Array from
  // AudioBuffer.getChannelData() to fail Transformers.js instanceof checks.
  if (
    decoded.sampleRate === WHISPER_SAMPLE_RATE &&
    decoded.numberOfChannels === 1
  ) {
    return new Float32Array(decoded.getChannelData(0));
  }

  // Resample + downmix via OfflineAudioContext (async, non-blocking).
  // The browser's resampler is higher quality than any JS implementation.
  const targetLength = Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE);
  const offlineCtx = new OfflineAudioContext(
    1, // channels — Whisper expects mono
    targetLength,
    WHISPER_SAMPLE_RATE,
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start(0);

  const rendered = await offlineCtx.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

// ─── Hook types ───────────────────────────────────────────────────────────────

export type ModelStatus = "unloaded" | "loading" | "ready";

export interface UseWhisperTranscriptionReturn {
  /** Current lifecycle state of the Whisper model. */
  modelStatus: ModelStatus;
  /** Download/initialisation progress 0–100. Meaningful only during "loading". */
  modelLoadProgress: number;
  /** True while audio bytes are being processed by the Whisper pipeline. */
  isTranscribing: boolean;
  /**
   * Start loading the model in the background without transcribing yet.
   * Call this when the user first opens a mic UI so the model is ready
   * by the time they finish speaking.  Safe to call multiple times.
   */
  warmUp: () => void;
  /**
   * Transcribe a WebM audio Blob captured by MediaRecorder.
   * Handles all decoding, resampling, and Whisper inference internally.
   * Resolves with the trimmed transcript string (empty string if silent).
   */
  transcribe: (blob: Blob) => Promise<string>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useWhisperTranscription(): UseWhisperTranscriptionReturn {
  // Initialise status from the singleton so remounts reflect the real state.
  const [modelStatus, setModelStatus] = useState<ModelStatus>(
    _pipe ? "ready" : "unloaded",
  );
  const [modelLoadProgress, setModelLoadProgress] = useState(_pipe ? 100 : 0);
  const [isTranscribing, setIsTranscribing] = useState(false);

  // Guard against double-loading inside a single hook instance.
  const isLoadingRef = useRef(false);

  const onProgress = useCallback((pct: number) => {
    setModelLoadProgress(Math.round(pct));
  }, []);

  /** Ensure the pipeline is ready, updating React state along the way. */
  const ensureReady = useCallback(async (): Promise<ASRPipeline> => {
    if (_pipe) return _pipe;

    if (!isLoadingRef.current) {
      isLoadingRef.current = true;
      setModelStatus("loading");
      setModelLoadProgress(0);
    }

    try {
      const pipe = await acquirePipeline(onProgress);
      setModelStatus("ready");
      setModelLoadProgress(100);
      isLoadingRef.current = false;
      return pipe;
    } catch (err) {
      isLoadingRef.current = false;
      setModelStatus("unloaded");
      throw err;
    }
  }, [onProgress]);

  const warmUp = useCallback((): void => {
    // No-op if already loaded or loading.
    if (_pipe || _loadPromise || isLoadingRef.current) return;
    void ensureReady().catch(() => {
      // Warm-up failures are silently ignored; transcribe() will retry.
    });
  }, [ensureReady]);

  const transcribe = useCallback(
    async (blob: Blob): Promise<string> => {
      setIsTranscribing(true);
      try {
        const pipe = await ensureReady();

        // Convert WebM blob → 16 kHz mono Float32Array
        const audioFloat32 = await blobToWhisperAudio(blob);

        // Reject clips that are too short to contain real speech.
        const durationSeconds = audioFloat32.length / WHISPER_SAMPLE_RATE;
        if (durationSeconds < 0.3) return "";

        // no_repeat_ngram_size: prevents the model repeating the same phrase in a loop.
        // condition_on_previous_text: false — stops the decoder conditioning on its
        // own prior output, which is the main cause of spurious prefix phrases like
        // "I'm gonna hide." appearing before the real speech.
        // language/task args are intentionally omitted — English-only model rejects them.
        const output = await (pipe as any)(audioFloat32, {
          no_repeat_ngram_size: 3,
          condition_on_previous_text: false,
        });

        // Pipeline returns { text } for a single input, or Array<{ text }> for batches.
        const raw: string = Array.isArray(output)
          ? (output[0]?.text ?? "")
          : ((output as { text?: string })?.text ?? "");

        // Strip known Whisper-tiny hallucination phrases from the start of the output.
        const text = stripHallucinationPrefix(raw.trim());
        if (!text) return "";

        // Hallucination guard: reject output that contains far more words than
        // could plausibly be spoken in the recorded duration.
        // Normal speech is ~2.5 words/sec; we allow up to 5 words/sec as a ceiling.
        const wordCount = text.split(/\s+/).length;
        if (wordCount > Math.ceil(durationSeconds * 5)) return "";

        // Repetition guard: if any 4-word sequence appears twice or more the
        // model is looping — discard the entire output.
        const words = text.toLowerCase().split(/\s+/);
        if (words.length >= 8) {
          const seen = new Set<string>();
          for (let i = 0; i <= words.length - 4; i++) {
            const gram = words.slice(i, i + 4).join(" ");
            if (seen.has(gram)) return "";
            seen.add(gram);
          }
        }

        return text;
      } finally {
        setIsTranscribing(false);
      }
    },
    [ensureReady],
  );

  return { modelStatus, modelLoadProgress, isTranscribing, warmUp, transcribe };
}
