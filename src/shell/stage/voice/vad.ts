/**
 * Voice activity detection.
 *
 * Energy-and-zero-crossing rather than Silero. The plan named Silero, and it is
 * better in noise, but it costs an ONNX model, a WASM warm-up and a download
 * before the mic works at all — and it cannot run inside an AudioWorklet, so it
 * would need frames posted to the main thread anyway. This is ~40 lines, works
 * offline on first launch, and browser `echoCancellation` already removes the
 * hard case (her own voice in the room).
 *
 * `detectFrame` is pure so the thresholds can be tested against synthesised
 * audio instead of by talking at a laptop. If recall ever proves inadequate in
 * a noisy room, this function is the seam: swap the body, keep the interface.
 */

export interface VadConfig {
  /**
   * RMS above which a frame might be speech.
   *
   * Speech at a normal desk distance sits around 0.02–0.2 RMS; room tone with
   * noise suppression on is usually below 0.005. This sits above the noise and
   * well below quiet speech.
   */
  energyThreshold: number;
  /**
   * Zero-crossing rate above which a loud frame is treated as noise.
   *
   * Voiced speech has strong low-frequency content and a low crossing rate;
   * keyboard clatter, fan whine and sibilant hiss cross zero far more often.
   * This is what stops typing from being heard as talking.
   */
  maxZeroCrossingRate: number;
  /**
   * Multiplier applied to the energy threshold while Marta is speaking.
   *
   * Echo cancellation is good, not perfect. Requiring the user to be
   * meaningfully louder than the residue is cheaper and more reliable than
   * trying to subtract her voice ourselves.
   */
  duckedThresholdMultiplier: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  energyThreshold: 0.012,
  maxZeroCrossingRate: 0.35,
  duckedThresholdMultiplier: 2.5,
};

export interface FrameMetrics {
  rms: number;
  zeroCrossingRate: number;
}

/** Root-mean-square amplitude and zero-crossing rate for one frame. */
export function frameMetrics(frame: Float32Array): FrameMetrics {
  if (frame.length === 0) return { rms: 0, zeroCrossingRate: 0 };

  let sumSquares = 0;
  let crossings = 0;
  let previous = frame[0];

  for (let i = 0; i < frame.length; i++) {
    const sample = frame[i];
    sumSquares += sample * sample;
    // Sign change, ignoring exact zeros so a run of digital silence does not
    // read as maximum crossing rate.
    if ((sample > 0 && previous < 0) || (sample < 0 && previous > 0)) {
      crossings++;
    }
    if (sample !== 0) previous = sample;
  }

  return {
    rms: Math.sqrt(sumSquares / frame.length),
    zeroCrossingRate: crossings / frame.length,
  };
}

/**
 * Is this frame speech?
 *
 * `ducked` is set while Marta is talking, and raises the bar so her own
 * residual output cannot interrupt her.
 */
export function detectFrame(
  frame: Float32Array,
  options: { ducked?: boolean; config?: VadConfig } = {},
): boolean {
  const config = options.config ?? DEFAULT_VAD_CONFIG;
  const { rms, zeroCrossingRate } = frameMetrics(frame);

  const threshold = options.ducked
    ? config.energyThreshold * config.duckedThresholdMultiplier
    : config.energyThreshold;

  if (rms < threshold) return false;
  // Loud but noisy: a fan, a keyboard, sibilance without voicing.
  if (zeroCrossingRate > config.maxZeroCrossingRate) return false;
  return true;
}
