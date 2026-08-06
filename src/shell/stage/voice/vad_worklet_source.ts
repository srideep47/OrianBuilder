/**
 * The AudioWorklet that turns the mic into fixed-size frames.
 *
 * Shipped as a source string and loaded from a Blob URL rather than as a file.
 * `audioWorklet.addModule()` takes a URL, and getting a separate .js file to
 * survive Vite's bundling, Electron's `file://` origin and the packaged asar
 * intact is a well-known source of "works in dev, 404 in production". A Blob
 * URL has no such problem.
 *
 * The worklet itself deliberately does almost nothing: it accumulates samples
 * into hop-sized frames and posts them. All the *judgement* — is this speech,
 * has the user finished, may they interrupt — lives in `vad.ts` and
 * `turn_taking.ts`, on the main thread, where it can be unit-tested. A worklet
 * runs on the audio render thread; putting decisions there would make them
 * untestable and would risk glitching playback.
 */

/** Samples per frame at the AudioContext's rate. 512 ≈ 32ms at 16kHz. */
export const VAD_HOP_SAMPLES = 512;

export const VAD_WORKLET_NAME = "marta-vad-frames";

export const VAD_WORKLET_SOURCE = `
class MartaVadFrames extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.hop = (options && options.processorOptions && options.processorOptions.hop) || ${VAD_HOP_SAMPLES};
    this.buffer = new Float32Array(this.hop);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    // No input connected yet, or the track ended. Keep the processor alive:
    // returning false here would permanently detach it and the mic would go
    // deaf after any momentary gap.
    if (!input || input.length === 0 || !input[0]) return true;

    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === this.hop) {
        // Copy: the buffer is reused immediately, and a transferred view would
        // be neutered before the main thread read it.
        this.port.postMessage(this.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor(${JSON.stringify(VAD_WORKLET_NAME)}, MartaVadFrames);
`;

/** A Blob URL for the worklet module. Caller revokes it when done. */
export function createVadWorkletUrl(): string {
  return URL.createObjectURL(
    new Blob([VAD_WORKLET_SOURCE], { type: "application/javascript" }),
  );
}
