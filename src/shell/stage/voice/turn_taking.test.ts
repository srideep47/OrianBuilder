/**
 * Turn-taking, including barge-in.
 *
 * These are the rules that decide whether the thing feels like a conversation
 * or like shouting at a kiosk, and every one of them is a timing decision that
 * is miserable to verify by talking at a laptop. Driving the reducer with
 * synthetic frame streams is the only way to check them repeatably.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TUNING,
  INITIAL_VOICE_STATE,
  isUtteranceLongEnough,
  orbStateFor,
  reduce,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceState,
} from "./turn_taking";

/** Run a sequence of events, collecting every effect in order. */
function run(
  start: VoiceState,
  events: VoiceEvent[],
): { state: VoiceState; effects: VoiceEffect[] } {
  let state = start;
  const effects: VoiceEffect[] = [];
  for (const event of events) {
    const step = reduce(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const frames = (count: number, speech: boolean): VoiceEvent[] =>
  Array.from({ length: count }, () => ({ type: "frame", speech }) as const);

/** Mic on, listening. */
function listening(): VoiceState {
  return reduce(INITIAL_VOICE_STATE, { type: "enable" }).state;
}

/** Mic on, mid-utterance. */
function capturing(): VoiceState {
  return run(listening(), frames(DEFAULT_TUNING.onsetFrames, true)).state;
}

/** Mic on, Marta speaking. */
function speaking(): VoiceState {
  const captured = run(
    capturing(),
    frames(DEFAULT_TUNING.endpointFrames, false),
  ).state;
  const thinking = reduce(captured, {
    type: "transcribed",
    text: "hello",
  }).state;
  return reduce(thinking, { type: "reply-started" }).state;
}

describe("enabling and disabling", () => {
  it("starts off and opens into listening", () => {
    expect(INITIAL_VOICE_STATE.phase).toBe("off");
    expect(listening().phase).toBe("listening");
  });

  it("releases everything on disable, whatever it was doing", () => {
    // Leaving TTS playing or a turn running after the user switched the mic
    // off is the kind of thing that gets an app called haunted.
    const mid = run(speaking(), []);
    const { state, effects } = run(mid.state, [{ type: "disable" }]);
    expect(state.phase).toBe("off");
    expect(effects.map((e) => e.type)).toContain("stop-speaking");

    const capturingOff = run(capturing(), [{ type: "disable" }]);
    expect(capturingOff.effects.map((e) => e.type)).toContain(
      "discard-capture",
    );

    const transcribing = run(
      capturing(),
      frames(DEFAULT_TUNING.endpointFrames, false),
    ).state;
    expect(
      run(transcribing, [{ type: "disable" }]).effects.map((e) => e.type),
    ).toContain("cancel-transcription");
  });

  it("cancels an in-flight turn on disable", () => {
    const thinking = reduce(
      run(capturing(), frames(DEFAULT_TUNING.endpointFrames, false)).state,
      { type: "transcribed", text: "hi" },
    ).state;
    const { effects } = run(thinking, [{ type: "disable" }]);
    expect(effects.map((e) => e.type)).toContain("cancel-turn");
  });
});

describe("onset", () => {
  it("needs a run of speech, not one frame", () => {
    // One frame fires on a door closing.
    const one = run(listening(), frames(1, true));
    expect(one.state.phase).toBe("listening");
    expect(one.effects).toEqual([]);

    const two = run(listening(), frames(DEFAULT_TUNING.onsetFrames, true));
    expect(two.state.phase).toBe("capturing");
    expect(two.effects).toEqual([{ type: "start-capture" }]);
  });

  it("resets the onset run when speech stops", () => {
    const state = run(listening(), [
      ...frames(1, true),
      ...frames(1, false),
      ...frames(1, true),
    ]).state;
    expect(state.phase).toBe("listening");
  });
});

describe("endpointing", () => {
  it("waits out a pause rather than cutting the sentence", () => {
    // Commas exist. Ending the turn on the first silent frame would cut people
    // off constantly.
    const state = run(capturing(), [
      ...frames(DEFAULT_TUNING.endpointFrames - 1, false),
      ...frames(3, true),
      ...frames(DEFAULT_TUNING.endpointFrames - 1, false),
    ]).state;
    expect(state.phase).toBe("capturing");
  });

  it("ends the utterance after sustained silence", () => {
    const { state, effects } = run(
      capturing(),
      frames(DEFAULT_TUNING.endpointFrames, false),
    );
    expect(state.phase).toBe("transcribing");
    expect(effects).toContainEqual({ type: "end-capture" });
  });
});

describe("transcription", () => {
  it("sends the turn when there are words", () => {
    const transcribing = run(
      capturing(),
      frames(DEFAULT_TUNING.endpointFrames, false),
    ).state;
    const { state, effects } = run(transcribing, [
      { type: "transcribed", text: "  open my projects  " },
    ]);
    expect(state.phase).toBe("thinking");
    expect(effects).toContainEqual({
      type: "send-turn",
      text: "open my projects",
    });
  });

  it("goes back to listening on an empty transcript", () => {
    // Whisper returns empty for silence and for stripped hallucinations.
    // Sending that would make her answer a question nobody asked.
    const transcribing = run(
      capturing(),
      frames(DEFAULT_TUNING.endpointFrames, false),
    ).state;
    const { state, effects } = run(transcribing, [
      { type: "transcribed", text: "   " },
    ]);
    expect(state.phase).toBe("listening");
    expect(effects).toEqual([]);
  });
});

describe("barge-in", () => {
  it("does not interrupt on a stray frame of her own voice", () => {
    // Echo cancellation is good, not perfect. A single frame crossing the
    // threshold must not cut her off.
    const { state, effects } = run(
      speaking(),
      frames(DEFAULT_TUNING.bargeInFrames - 1, true),
    );
    expect(state.phase).toBe("speaking");
    expect(effects).toEqual([]);
  });

  it("resets the run when the noise stops", () => {
    const state = run(speaking(), [
      ...frames(DEFAULT_TUNING.bargeInFrames - 1, true),
      ...frames(1, false),
      ...frames(DEFAULT_TUNING.bargeInFrames - 1, true),
    ]).state;
    expect(state.phase).toBe("speaking");
  });

  it("interrupts on a sustained run, and starts capturing at once", () => {
    const { state, effects } = run(
      speaking(),
      frames(DEFAULT_TUNING.bargeInFrames, true),
    );
    expect(state.phase).toBe("capturing");
    // Both, in this order: stop her, then capture — going back to "listening"
    // and waiting for onset again would clip the start of what the user said.
    expect(effects).toEqual([
      { type: "stop-speaking" },
      { type: "cancel-turn" },
      { type: "start-capture" },
    ]);
    expect(state.interrupted).toBe(true);
  });

  it("requires more evidence to interrupt than to start listening", () => {
    // The cost of a false interruption is much worse than the cost of a
    // slightly slower one.
    expect(DEFAULT_TUNING.bargeInFrames).toBeGreaterThan(
      DEFAULT_TUNING.onsetFrames,
    );
  });

  it("completes the whole interrupted round trip", () => {
    // The plan's demo criterion: a spoken command, interrupted mid-answer,
    // recovers correctly.
    let state = speaking();
    const all: VoiceEffect[] = [];

    const bargeIn = run(state, frames(DEFAULT_TUNING.bargeInFrames, true));
    state = bargeIn.state;
    all.push(...bargeIn.effects);

    const secondUtterance = run(state, [
      ...frames(4, true),
      ...frames(DEFAULT_TUNING.endpointFrames, false),
      { type: "transcribed", text: "actually show me the gallery" },
    ]);
    state = secondUtterance.state;
    all.push(...secondUtterance.effects);

    expect(state.phase).toBe("thinking");
    expect(all).toContainEqual({
      type: "send-turn",
      text: "actually show me the gallery",
    });

    const replied = run(state, [
      { type: "reply-started" },
      { type: "reply-finished" },
    ]);
    expect(replied.state.phase).toBe("listening");
    // The interrupted flag is cleared once a turn completes cleanly.
    expect(replied.state.interrupted).toBe(false);
  });
});

describe("frames while work is in flight", () => {
  it("supersedes transcription only after sustained new speech", () => {
    const transcribing = run(
      capturing(),
      frames(DEFAULT_TUNING.endpointFrames, false),
    ).state;
    const stray = run(
      transcribing,
      frames(DEFAULT_TUNING.bargeInFrames - 1, true),
    );
    expect(stray.state.phase).toBe("transcribing");
    expect(stray.effects).toEqual([]);

    const interruption = run(
      transcribing,
      frames(DEFAULT_TUNING.bargeInFrames, true),
    );
    expect(interruption.state.phase).toBe("capturing");
    expect(interruption.effects).toEqual([
      { type: "cancel-transcription" },
      { type: "start-capture" },
    ]);
  });

  it("cancels a sustained interruption while Marta is thinking", () => {
    const transcribing = run(
      capturing(),
      frames(DEFAULT_TUNING.endpointFrames, false),
    ).state;
    const thinking = reduce(transcribing, {
      type: "transcribed",
      text: "hi",
    }).state;
    const { state, effects } = run(
      thinking,
      frames(DEFAULT_TUNING.bargeInFrames, true),
    );

    expect(state.phase).toBe("capturing");
    expect(state.interrupted).toBe(true);
    expect(effects).toEqual([
      { type: "cancel-turn" },
      { type: "start-capture" },
    ]);
  });

  it("ignores frames entirely when off", () => {
    const { state, effects } = run(INITIAL_VOICE_STATE, frames(50, true));
    expect(state).toEqual(INITIAL_VOICE_STATE);
    expect(effects).toEqual([]);
  });
});

describe("reply outcomes", () => {
  it("returns to listening whether the reply succeeded or failed", () => {
    expect(reduce(speaking(), { type: "reply-finished" }).state.phase).toBe(
      "listening",
    );

    const thinking = reduce(
      run(capturing(), frames(DEFAULT_TUNING.endpointFrames, false)).state,
      { type: "transcribed", text: "hi" },
    ).state;
    expect(reduce(thinking, { type: "reply-failed" }).state.phase).toBe(
      "listening",
    );
  });
});

describe("utterance length", () => {
  it("rejects a cough", () => {
    expect(isUtteranceLongEnough(DEFAULT_TUNING.minUtteranceFrames - 1)).toBe(
      false,
    );
    expect(isUtteranceLongEnough(DEFAULT_TUNING.minUtteranceFrames)).toBe(true);
  });
});

describe("orbStateFor", () => {
  it("maps each phase to exactly one visual state", () => {
    expect(orbStateFor("listening")).toMatchObject({ listening: true });
    expect(orbStateFor("capturing")).toMatchObject({ listening: true });
    expect(orbStateFor("thinking")).toMatchObject({ busy: true });
    expect(orbStateFor("speaking")).toMatchObject({ speaking: true });
    expect(orbStateFor("off")).toEqual({
      listening: false,
      busy: false,
      speaking: false,
    });
  });
});
