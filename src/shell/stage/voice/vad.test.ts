/**
 * VAD thresholds, checked against synthesised audio.
 *
 * The point is that these numbers are the difference between "hears you" and
 * "types at you and thinks you are talking", and neither can be verified by
 * reading them.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_VAD_CONFIG, detectFrame, frameMetrics } from "./vad";

const SIZE = 512;

function fill(fn: (i: number) => number): Float32Array {
  const frame = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) frame[i] = fn(i);
  return frame;
}

/** A voiced vowel: low frequency, strong amplitude. */
const voicedSpeech = (amplitude = 0.08) =>
  fill((i) => amplitude * Math.sin((2 * Math.PI * 140 * i) / 16_000));

/** Room tone with noise suppression on. */
const roomTone = () => fill(() => (Math.random() - 0.5) * 0.004);

/** Keyboard clatter / hiss: loud, but crossing zero constantly. */
const broadbandNoise = (amplitude = 0.2) =>
  fill(() => (Math.random() - 0.5) * 2 * amplitude);

const silence = () => new Float32Array(SIZE);

describe("frameMetrics", () => {
  it("measures amplitude", () => {
    expect(frameMetrics(silence()).rms).toBe(0);
    expect(frameMetrics(voicedSpeech(0.08)).rms).toBeGreaterThan(0.05);
  });

  it("separates voiced speech from broadband noise by crossing rate", () => {
    // This is the whole reason the crossing rate is measured: both can be
    // loud, and only one is someone talking.
    const speech = frameMetrics(voicedSpeech());
    const noise = frameMetrics(broadbandNoise());
    expect(speech.zeroCrossingRate).toBeLessThan(noise.zeroCrossingRate);
    expect(speech.zeroCrossingRate).toBeLessThan(
      DEFAULT_VAD_CONFIG.maxZeroCrossingRate,
    );
    expect(noise.zeroCrossingRate).toBeGreaterThan(
      DEFAULT_VAD_CONFIG.maxZeroCrossingRate,
    );
  });

  it("does not report digital silence as maximum crossing rate", () => {
    // A naive sign check counts every zero sample as a crossing, which would
    // make silence look like the noisiest possible signal.
    expect(frameMetrics(silence()).zeroCrossingRate).toBe(0);
  });

  it("handles an empty frame", () => {
    expect(frameMetrics(new Float32Array(0))).toEqual({
      rms: 0,
      zeroCrossingRate: 0,
    });
  });
});

describe("detectFrame", () => {
  it("hears speech", () => {
    expect(detectFrame(voicedSpeech())).toBe(true);
  });

  it("ignores silence and room tone", () => {
    expect(detectFrame(silence())).toBe(false);
    expect(detectFrame(roomTone())).toBe(false);
  });

  it("ignores loud broadband noise", () => {
    // Typing while she is answering must not read as an interruption.
    expect(detectFrame(broadbandNoise(0.3))).toBe(false);
  });

  it("hears quiet speech at a normal desk distance", () => {
    expect(detectFrame(voicedSpeech(0.02))).toBe(true);
  });

  it("raises the bar while she is speaking", () => {
    // Echo residue is quiet but voiced, so the crossing-rate test will not
    // reject it — only the raised threshold will.
    const residue = voicedSpeech(0.02);
    expect(detectFrame(residue)).toBe(true);
    expect(detectFrame(residue, { ducked: true })).toBe(false);

    // A person actually talking over her is still heard.
    expect(detectFrame(voicedSpeech(0.1), { ducked: true })).toBe(true);
  });

  it("keeps the ducked threshold above the open one", () => {
    expect(DEFAULT_VAD_CONFIG.duckedThresholdMultiplier).toBeGreaterThan(1);
  });
});
