/**
 * The turn-taking state machine, as a pure function.
 *
 * Barge-in is the part of a voice assistant that is hard, and it is hard for
 * reasons that have nothing to do with audio APIs: the rules about *when* the
 * user is allowed to interrupt, what happens to work already in flight, and how
 * the assistant's own voice is prevented from interrupting her, are all timing
 * logic. Keeping them here — pure, synchronous, no Web Audio, no React — is
 * what makes them testable at all.
 *
 * The audio layer's only job is to report events into `reduce()`; everything it
 * should do next comes back as `effects`.
 */

export type VoicePhase =
  /** Mic off entirely. */
  | "off"
  /** Mic open, waiting for speech. */
  | "listening"
  /** The user is talking; audio is being captured. */
  | "capturing"
  /** Speech ended; the audio is being transcribed. */
  | "transcribing"
  /** Marta is working on a reply. */
  | "thinking"
  /** Marta is speaking. */
  | "speaking";

export interface VoiceState {
  phase: VoicePhase;
  /**
   * Consecutive frames of speech heard while Marta is speaking.
   *
   * Barge-in requires a *run*, not a single frame. Even with browser echo
   * cancellation, a syllable of her own voice or a cough will occasionally
   * cross the threshold, and interrupting her every time that happened would
   * make her impossible to listen to.
   */
  bargeInFrames: number;
  /** Consecutive silent frames while capturing, for endpointing. */
  silenceFrames: number;
  /** Frames of speech seen while listening, before capture is committed. */
  onsetFrames: number;
  /** Set when a turn was cut short, so the UI can say so rather than go quiet. */
  interrupted: boolean;
}

export const INITIAL_VOICE_STATE: VoiceState = {
  phase: "off",
  bargeInFrames: 0,
  silenceFrames: 0,
  onsetFrames: 0,
  interrupted: false,
};

export type VoiceEvent =
  | { type: "enable" }
  | { type: "disable" }
  /** One VAD frame. `speech` is the detector's verdict for this frame. */
  | { type: "frame"; speech: boolean }
  | { type: "transcribed"; text: string }
  | { type: "reply-started" }
  | { type: "reply-finished" }
  /** The turn failed, or produced nothing to say. */
  | { type: "reply-failed" };

export type VoiceEffect =
  | { type: "start-capture" }
  /** Stop capturing and hand the buffer to STT. */
  | { type: "end-capture" }
  /** Throw the captured audio away — it was too short to be speech. */
  | { type: "discard-capture" }
  | { type: "send-turn"; text: string }
  /** Stop TTS playback immediately. */
  | { type: "stop-speaking" }
  /** Abort or supersede speech recognition without cancelling a Marta turn. */
  | { type: "cancel-transcription" }
  /** Abort the in-flight turn. */
  | { type: "cancel-turn" };

export interface VoiceTuning {
  /**
   * Frames of speech before capture starts.
   *
   * Two, not one: a single frame fires on a door closing. Two at ~32ms is
   * still well under the time it takes to say a syllable, so nothing is
   * clipped from the front — the capture buffer is pre-rolled anyway.
   */
  onsetFrames: number;
  /**
   * Silent frames before an utterance is considered finished.
   *
   * This is the single most user-visible number in the whole system. Too short
   * and it cuts people off mid-sentence at every comma; too long and the
   * assistant feels slow to react. ~600ms of silence is the usual sweet spot
   * for natural speech.
   */
  endpointFrames: number;
  /**
   * Frames of speech required to interrupt Marta.
   *
   * Higher than `onsetFrames` on purpose: her own voice is in the room, and
   * the cost of a false positive (cutting her off mid-sentence for nothing) is
   * much worse than the cost of a false negative (needing to speak for another
   * 100ms).
   */
  bargeInFrames: number;
  /** Below this many captured frames, the utterance is noise, not speech. */
  minUtteranceFrames: number;
}

/** ~32ms per frame at 16kHz with a 512-sample hop. */
export const DEFAULT_TUNING: VoiceTuning = {
  onsetFrames: 2,
  endpointFrames: 19,
  bargeInFrames: 5,
  minUtteranceFrames: 8,
};

export interface Transition {
  state: VoiceState;
  effects: VoiceEffect[];
}

function next(state: VoiceState, effects: VoiceEffect[] = []): Transition {
  return { state, effects };
}

/**
 * Apply one event.
 *
 * Total and synchronous: every (phase, event) pair either transitions or is
 * explicitly ignored. An unhandled combination returning the state unchanged is
 * the correct behaviour for a stream of VAD frames arriving 30 times a second
 * during phases that do not care about them.
 */
export function reduce(
  state: VoiceState,
  event: VoiceEvent,
  tuning: VoiceTuning = DEFAULT_TUNING,
): Transition {
  switch (event.type) {
    case "enable":
      if (state.phase !== "off") return next(state);
      return next({ ...INITIAL_VOICE_STATE, phase: "listening" });

    case "disable": {
      const effects: VoiceEffect[] = [];
      if (state.phase === "capturing")
        effects.push({ type: "discard-capture" });
      if (state.phase === "speaking") effects.push({ type: "stop-speaking" });
      if (state.phase === "transcribing")
        effects.push({ type: "cancel-transcription" });
      if (state.phase === "thinking") effects.push({ type: "cancel-turn" });
      return next({ ...INITIAL_VOICE_STATE, phase: "off" }, effects);
    }

    case "frame":
      return onFrame(state, event.speech, tuning);

    case "transcribed": {
      if (state.phase !== "transcribing") return next(state);
      const text = event.text.trim();
      if (!text) {
        // Whisper returns empty for silence and for its own hallucinated
        // filler once stripped. Going straight back to listening is right —
        // sending an empty turn would make her answer a question nobody asked.
        return next({ ...INITIAL_VOICE_STATE, phase: "listening" });
      }
      return next({ ...state, phase: "thinking", silenceFrames: 0 }, [
        { type: "send-turn", text },
      ]);
    }

    case "reply-started":
      if (state.phase !== "thinking") return next(state);
      return next({ ...state, phase: "speaking", bargeInFrames: 0 });

    case "reply-finished":
    case "reply-failed":
      if (state.phase !== "speaking" && state.phase !== "thinking") {
        return next(state);
      }
      return next({ ...INITIAL_VOICE_STATE, phase: "listening" });

    default:
      return next(state);
  }
}

function onFrame(
  state: VoiceState,
  speech: boolean,
  tuning: VoiceTuning,
): Transition {
  switch (state.phase) {
    case "listening": {
      if (!speech) {
        return state.onsetFrames === 0
          ? next(state)
          : next({ ...state, onsetFrames: 0 });
      }
      const onsetFrames = state.onsetFrames + 1;
      if (onsetFrames < tuning.onsetFrames) {
        return next({ ...state, onsetFrames });
      }
      return next(
        { ...state, phase: "capturing", onsetFrames: 0, silenceFrames: 0 },
        [{ type: "start-capture" }],
      );
    }

    case "capturing": {
      if (speech) {
        return state.silenceFrames === 0
          ? next(state)
          : next({ ...state, silenceFrames: 0 });
      }
      const silenceFrames = state.silenceFrames + 1;
      if (silenceFrames < tuning.endpointFrames) {
        return next({ ...state, silenceFrames });
      }
      return next({ ...state, phase: "transcribing", silenceFrames: 0 }, [
        { type: "end-capture" },
      ]);
    }

    case "speaking": {
      if (!speech) {
        return state.bargeInFrames === 0
          ? next(state)
          : next({ ...state, bargeInFrames: 0 });
      }
      const bargeInFrames = state.bargeInFrames + 1;
      if (bargeInFrames < tuning.bargeInFrames) {
        return next({ ...state, bargeInFrames });
      }
      // Interrupted. Stop her mid-word and start capturing immediately — the
      // user is already several frames into speaking, so going back to
      // "listening" and waiting for onset would clip the start of what they
      // said.
      return next(
        {
          ...state,
          phase: "capturing",
          bargeInFrames: 0,
          silenceFrames: 0,
          interrupted: true,
        },
        [
          { type: "stop-speaking" },
          { type: "cancel-turn" },
          { type: "start-capture" },
        ],
      );
    }

    case "transcribing":
    case "thinking": {
      if (!speech) {
        return state.bargeInFrames === 0
          ? next(state)
          : next({ ...state, bargeInFrames: 0 });
      }
      const bargeInFrames = state.bargeInFrames + 1;
      if (bargeInFrames < tuning.bargeInFrames) {
        return next({ ...state, bargeInFrames });
      }
      // A real voice assistant cannot make the user wait for work they have
      // already superseded. The ASR and Marta turn use distinct cancellation
      // effects so interrupting endpointed transcription cannot accidentally
      // cancel an unrelated model turn.
      return next(
        {
          ...state,
          phase: "capturing",
          bargeInFrames: 0,
          silenceFrames: 0,
          interrupted: true,
        },
        [
          {
            type:
              state.phase === "transcribing"
                ? "cancel-transcription"
                : "cancel-turn",
          },
          { type: "start-capture" },
        ],
      );
    }

    default:
      return next(state);
  }
}

/** Whether the captured audio is long enough to be worth transcribing. */
export function isUtteranceLongEnough(
  capturedFrames: number,
  tuning: VoiceTuning = DEFAULT_TUNING,
): boolean {
  return capturedFrames >= tuning.minUtteranceFrames;
}

/** What the orb should show. Kept here so the UI has no timing logic of its own. */
export function orbStateFor(phase: VoicePhase): {
  listening: boolean;
  busy: boolean;
  speaking: boolean;
} {
  return {
    listening: phase === "listening" || phase === "capturing",
    busy: phase === "transcribing" || phase === "thinking",
    speaking: phase === "speaking",
  };
}
