/**
 * The microphone: capture, framing, and building a WAV the transcriber accepts.
 *
 * Everything here is imperative Web Audio plumbing with no policy in it. It
 * reports frames; `turn_taking.ts` decides what they mean.
 *
 * **Pre-roll** is the one subtle piece. Speech is only recognised as speech a
 * frame or two after it starts, so capture that began at the moment of
 * detection would be missing the first consonant of the first word — which is
 * exactly the part Whisper needs. A small ring buffer of recent frames is kept
 * at all times and prepended when capture starts.
 */

import {
  createVadWorkletUrl,
  VAD_HOP_SAMPLES,
  VAD_WORKLET_NAME,
} from "./vad_worklet_source";
import { CLOSED_MICROPHONE_HEALTH, type MicrophoneHealth } from "./runtime";

/** Frames of audio kept before detection, so word onsets are not clipped. */
export const PREROLL_FRAMES = 8;

export interface MicSessionOptions {
  onFrame: (frame: Float32Array) => void;
  onError: (error: Error) => void;
  onHealthChange?: (health: MicrophoneHealth) => void;
}

export interface VoiceCaptureSession {
  readonly sampleRate: number;
  readonly isOpen: boolean;
  readonly capturedFrames: number;
  readonly isBargeInSafe: boolean;
  getHealth(): MicrophoneHealth;
  open(): Promise<void>;
  close(): Promise<void>;
  startCapture(): void;
  discardCapture(): void;
  endCapture(): Blob | null;
}

function cancelledOpenError(): DOMException {
  return new DOMException("Microphone opening was cancelled.", "AbortError");
}

export class MicSession implements VoiceCaptureSession {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private workletUrl: string | null = null;
  private openPromise: Promise<void> | null = null;
  private lifecycleToken = 0;
  private trackEnded: (() => void) | null = null;
  private health: MicrophoneHealth = { ...CLOSED_MICROPHONE_HEALTH };

  private preroll: Float32Array[] = [];
  private captured: Float32Array[] | null = null;

  constructor(private readonly options: MicSessionOptions) {}

  get sampleRate(): number {
    return this.context?.sampleRate ?? 48_000;
  }

  get isOpen(): boolean {
    return this.health.state === "open";
  }

  /** False only when the device explicitly reports that AEC is unavailable. */
  get isBargeInSafe(): boolean {
    return this.health.echoControl !== "unavailable";
  }

  /** Frames captured so far in the current utterance, pre-roll included. */
  get capturedFrames(): number {
    return this.captured?.length ?? 0;
  }

  getHealth(): MicrophoneHealth {
    return { ...this.health };
  }

  async open(): Promise<void> {
    if (this.isOpen) return;
    if (this.openPromise) return this.openPromise;

    const token = ++this.lifecycleToken;
    this.updateHealth({ state: "opening", detail: undefined });
    const attempt = this.openInternal(token);
    this.openPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.openPromise === attempt) this.openPromise = null;
    }
  }

  async close(): Promise<void> {
    const token = ++this.lifecycleToken;
    if (this.health.state !== "closed") {
      this.updateHealth({ state: "closing", detail: undefined });
    }
    this.captured = null;
    this.preroll = [];

    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    this.source?.disconnect();
    this.source = null;

    const track = this.stream?.getAudioTracks()[0];
    if (track && this.trackEnded) {
      track.removeEventListener("ended", this.trackEnded);
    }
    this.trackEnded = null;
    this.stream?.getTracks().forEach((streamTrack) => streamTrack.stop());
    this.stream = null;

    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
    if (token === this.lifecycleToken) {
      this.health = {
        ...CLOSED_MICROPHONE_HEALTH,
        checkedAt: Date.now(),
      };
      this.options.onHealthChange?.(this.getHealth());
    }
  }

  private async openInternal(token: number): Promise<void> {
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let node: AudioWorkletNode | null = null;
    let workletUrl: string | null = null;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This runtime does not expose microphone capture.");
      }

      // All three constraints matter, and `echoCancellation` most of all: it
      // prevents Marta's own voice coming back through the microphone. A rare
      // device that rejects enhanced constraints gets a capture-only fallback,
      // but health reports the missing AEC and acoustic barge-in is disabled.
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (error) {
        if (
          !(error instanceof DOMException) ||
          error.name !== "OverconstrainedError"
        ) {
          throw error;
        }
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      this.assertCurrent(token);

      context = new AudioContext({ latencyHint: "interactive" });
      if (context.state === "suspended") await context.resume();
      this.assertCurrent(token);

      workletUrl = createVadWorkletUrl();
      await context.audioWorklet.addModule(workletUrl);
      this.assertCurrent(token);

      source = context.createMediaStreamSource(stream);
      node = new AudioWorkletNode(context, VAD_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { hop: VAD_HOP_SAMPLES },
      });
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (token !== this.lifecycleToken) return;
        const frame = event.data;
        this.remember(frame);
        try {
          this.options.onFrame(frame);
        } catch (error) {
          this.options.onError(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      };

      // Never route the mic to the speakers. That creates the feedback loop
      // echo cancellation is intended to remove.
      source.connect(node);
      this.assertCurrent(token);

      this.stream = stream;
      this.context = context;
      this.source = source;
      this.node = node;
      this.workletUrl = workletUrl;
      stream = null;
      context = null;
      source = null;
      node = null;
      workletUrl = null;

      const track = this.stream.getAudioTracks()[0];
      const settings = track?.getSettings?.() ?? {};
      const echoControl =
        settings.echoCancellation === true
          ? "active"
          : settings.echoCancellation === false
            ? "unavailable"
            : "unverified";
      this.trackEnded = () => {
        if (token !== this.lifecycleToken) return;
        const error = new Error("The active microphone was disconnected.");
        this.updateHealth({ state: "error", detail: error.message });
        this.options.onError(error);
      };
      track?.addEventListener("ended", this.trackEnded, { once: true });

      this.health = {
        state: "open",
        echoControl,
        noiseSuppression: settings.noiseSuppression ?? null,
        autoGainControl: settings.autoGainControl ?? null,
        sampleRate: settings.sampleRate ?? this.context.sampleRate,
        deviceLabel: track?.label || undefined,
        detail:
          echoControl === "unavailable"
            ? "Capture is available, but this device did not enable echo cancellation."
            : undefined,
        checkedAt: Date.now(),
      };
      this.options.onHealthChange?.(this.getHealth());
    } catch (error) {
      if (node) {
        node.port.onmessage = null;
        node.disconnect();
      }
      source?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      await context?.close().catch(() => {});
      if (workletUrl) URL.revokeObjectURL(workletUrl);

      if (token === this.lifecycleToken) {
        const message =
          error instanceof Error ? error.message : "Microphone opening failed.";
        this.updateHealth({ state: "error", detail: message });
      }
      throw error;
    }
  }

  private assertCurrent(token: number): void {
    if (token !== this.lifecycleToken) throw cancelledOpenError();
  }

  private updateHealth(update: Partial<MicrophoneHealth>): void {
    this.health = { ...this.health, ...update, checkedAt: Date.now() };
    this.options.onHealthChange?.(this.getHealth());
  }

  private remember(frame: Float32Array): void {
    if (this.captured) {
      this.captured.push(frame);
      return;
    }
    this.preroll.push(frame);
    if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
  }

  /** Begin an utterance, seeded with the pre-roll. */
  startCapture(): void {
    this.captured = [...this.preroll];
    this.preroll = [];
  }

  /** Throw the current utterance away. */
  discardCapture(): void {
    this.captured = null;
    this.preroll = [];
  }

  /**
   * Finish the utterance and return it as a WAV blob.
   *
   * WAV rather than WebM because `useWhisperTranscription` decodes through
   * `AudioContext.decodeAudioData`, which handles WAV natively — and because
   * re-encoding to Opus just to decode it again would add latency to the one
   * path where latency is the whole product.
   */
  endCapture(): Blob | null {
    const frames = this.captured;
    this.captured = null;
    if (!frames || frames.length === 0) return null;
    return encodeWav(frames, this.sampleRate);
  }
}

/** Concatenated Float32 frames → a 16-bit mono PCM WAV. */
export function encodeWav(frames: Float32Array[], sampleRate: number): Blob {
  let total = 0;
  for (const frame of frames) total += frame.length;

  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, total * 2, true);

  let offset = 44;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i++) {
      // Clamp before scaling: Web Audio samples can exceed ±1 after gain, and
      // wrapping would turn a loud word into a burst of noise.
      const sample = Math.max(-1, Math.min(1, frame[i]));
      view.setInt16(offset, sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}
