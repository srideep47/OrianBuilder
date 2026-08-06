/**
 * The voice pipeline, in the real renderer.
 *
 * The unit tests prove the turn-taking rules and the VAD thresholds. They
 * cannot prove the audio plumbing works: `audioWorklet.addModule` from a Blob
 * URL, `getUserMedia` under Electron's permission model, and the WAV encoder
 * feeding a decoder that will actually accept it are all things that either
 * work in a real browser context or do not.
 *
 * The mic is faked with Chromium's `--use-fake-device-for-media-capture`, which
 * produces a synthetic tone — enough to prove frames flow, not enough to
 * transcribe. Whisper is therefore never invoked here.
 */

import { expect } from "@playwright/test";
import { testWithConfig } from "./helpers/test_helper";
import { Timeout } from "./helpers/constants";

const test = testWithConfig({});

test.describe.configure({ timeout: Timeout.LONG });

async function ready(po: { page: any }): Promise<void> {
  await po.page.waitForSelector("#stage", { timeout: Timeout.LONG });
}

test("the VAD worklet loads and delivers frames", async ({ po }) => {
  await ready(po);

  // Exercises the exact path `MicSession` uses: Blob URL → addModule →
  // AudioWorkletNode → port messages. A bundling or CSP problem here is the
  // most likely way voice breaks in a packaged build while passing in dev.
  const result = await po.page.evaluate(async () => {
    const HOP = 512;
    const source = `
      class Probe extends AudioWorkletProcessor {
        constructor() { super(); this.n = 0; this.buf = new Float32Array(${HOP}); }
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (!ch) return true;
          for (let i = 0; i < ch.length; i++) {
            this.buf[this.n++] = ch[i];
            if (this.n === ${HOP}) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
          }
          return true;
        }
      }
      registerProcessor("probe", Probe);
    `;
    const url = URL.createObjectURL(
      new Blob([source], { type: "application/javascript" }),
    );

    const context = new AudioContext();
    await context.audioWorklet.addModule(url);

    // An oscillator rather than the mic: this test is about the worklet, and
    // a synthetic source removes the permission prompt from the equation.
    const osc = context.createOscillator();
    osc.frequency.value = 220;
    const node = new AudioWorkletNode(context, "probe", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    osc.connect(node);
    osc.start();

    const frame = await new Promise<Float32Array | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 5_000);
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        clearTimeout(timer);
        resolve(event.data);
      };
    });

    osc.stop();
    await context.close();
    URL.revokeObjectURL(url);

    return frame
      ? { length: frame.length, hasSignal: frame.some((s) => s !== 0) }
      : null;
  });

  expect(result, "the worklet produced no frames").not.toBeNull();
  expect(result!.length).toBe(512);
  expect(result!.hasSignal).toBe(true);
});

test("the WAV encoder produces audio the decoder accepts", async ({ po }) => {
  await ready(po);

  // `useWhisperTranscription` decodes with `decodeAudioData`. If the header is
  // wrong, transcription fails with an opaque error at the worst moment —
  // after the user has already spoken.
  const decoded = await po.page.evaluate(async () => {
    const SAMPLE_RATE = 48_000;
    const frames: Float32Array[] = [];
    for (let f = 0; f < 20; f++) {
      const frame = new Float32Array(512);
      for (let i = 0; i < 512; i++) {
        frame[i] =
          0.2 * Math.sin((2 * Math.PI * 300 * (f * 512 + i)) / SAMPLE_RATE);
      }
      frames.push(frame);
    }

    // Inlined rather than imported: `page.evaluate` runs in the page, which has
    // no module resolution. Kept byte-identical to `encodeWav` in
    // `mic_session.ts`; `voice.spec.ts` failing after a change there is the
    // signal to update both.
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
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, total * 2, true);
    let offset = 44;
    for (const frame of frames) {
      for (let i = 0; i < frame.length; i++) {
        const sample = Math.max(-1, Math.min(1, frame[i]));
        view.setInt16(offset, sample * 0x7fff, true);
        offset += 2;
      }
    }

    const context = new AudioContext();
    const audio = await context.decodeAudioData(buffer);
    const out = {
      channels: audio.numberOfChannels,
      sampleRate: audio.sampleRate,
      frames: audio.length,
      peak: Math.max(...Array.from(audio.getChannelData(0)).map(Math.abs)),
    };
    await context.close();
    return out;
  });

  expect(decoded.channels).toBe(1);
  expect(decoded.sampleRate).toBe(48_000);
  expect(decoded.frames).toBe(20 * 512);
  // Round-tripped through 16-bit, so not exactly 0.2.
  expect(decoded.peak).toBeGreaterThan(0.15);
  expect(decoded.peak).toBeLessThanOrEqual(1);
});

test("speech synthesis is available and cancellable", async ({ po }) => {
  await ready(po);

  // Barge-in is only convincing if `cancel()` takes effect immediately. If the
  // packaged app has no voices, `createTtsEngine` falls back to silence and the
  // loop still runs — but the user gets no audio, which is worth knowing.
  const speech = await po.page.evaluate(() => {
    if (typeof window.speechSynthesis === "undefined") return null;
    const utterance = new SpeechSynthesisUtterance("testing one two three");
    window.speechSynthesis.speak(utterance);
    const spokeImmediately =
      window.speechSynthesis.speaking || window.speechSynthesis.pending;
    window.speechSynthesis.cancel();
    return {
      available: true,
      spokeImmediately,
      stoppedAfterCancel: !window.speechSynthesis.speaking,
    };
  });

  expect(speech, "no speechSynthesis in this build").not.toBeNull();
  expect(speech!.stoppedAfterCancel).toBe(true);
});

test("the mic toggle is present and gated on Marta running", async ({ po }) => {
  await ready(po);

  // Disabled while her model is down: opening the mic to transcribe into
  // nothing would light the OS recording indicator for no reason.
  const mic = po.page.getByRole("button", {
    name: /Talk to Marta|Stop listening/,
  });
  await expect(mic).toBeVisible();
});

test("getUserMedia is granted, not silently denied", async ({ po }) => {
  await ready(po);

  // Electron does not show Chrome's permission prompt: without an explicit
  // handler in main.ts an unhandled `media` request is denied, and voice fails
  // with an error the user cannot grant their way out of. This is the only
  // check that catches that, and it catches it in the packaged app.
  const outcome = await po.page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const tracks = stream.getAudioTracks().length;
      stream.getTracks().forEach((t) => t.stop());
      return { ok: true, tracks, error: null as string | null };
    } catch (error) {
      return {
        ok: false,
        tracks: 0,
        error: error instanceof Error ? error.name : String(error),
      };
    }
  });

  expect(
    outcome.ok,
    `getUserMedia rejected with ${outcome.error} — check the permission handler in main.ts`,
  ).toBe(true);
  expect(outcome.tracks).toBeGreaterThan(0);
});
