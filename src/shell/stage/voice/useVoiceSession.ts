/**
 * Wiring the pure turn-taking machine to qualified audio backends.
 *
 * VAD still runs outside React state because frames arrive roughly 30 times a
 * second. React only observes human-scale state: phase, health and errors.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useWhisperTranscription } from "@/hooks/useWhisperTranscription";
import {
  createWhisperAsrBackend,
  type AsrBackend,
  type AsrTranscriptUpdate,
} from "./asr";
import {
  MicSession,
  type MicSessionOptions,
  type VoiceCaptureSession,
} from "./mic_session";
import { NarrationQueue } from "./narration_queue";
import {
  collapseDeferred,
  decideNarration,
  type NarrationDecision,
  type NarrationDetail,
  type ProactiveNarrationInput,
} from "./narration_policy";
import {
  CLOSED_MICROPHONE_HEALTH,
  summarizeVoiceRuntimeHealth,
  type MicrophoneHealth,
  type NarrationHealth,
  type VoiceRuntimeHealth,
} from "./runtime";
import {
  createTtsEngine,
  takeStreamingSpeechChunks,
  type TtsEngine,
} from "./tts";
import {
  DEFAULT_TUNING,
  INITIAL_VOICE_STATE,
  isUtteranceLongEnough,
  reduce,
  type VoiceEvent,
  type VoicePhase,
  type VoiceState,
} from "./turn_taking";
import { detectFrame } from "./vad";

export interface VoiceSessionOptions {
  /** Run a turn and expose narration as it is generated. */
  onUtterance: (
    text: string,
    callbacks: {
      onTextDelta: (text: string) => void;
      onReplyStarted: () => void;
    },
  ) => Promise<string>;
  /** Abort a live Marta turn when the user barges in while she is thinking. */
  onCancelTurn?: () => void | Promise<void>;
  /** Repeated, revisable ASR text. The bundled Whisper backend emits final only. */
  onTranscriptUpdate?: (update: AsrTranscriptUpdate) => void;
  /** Fixed for the lifetime of this session; remount to change runtime backend. */
  asrBackend?: AsrBackend;
  /** A local neural backend can be injected; Web Speech remains the fallback. */
  ttsEngine?: TtsEngine;
  /** Dependency seam used by deterministic tests and alternate capture hosts. */
  createMicSession?: (options: MicSessionOptions) => VoiceCaptureSession;
  onHealthChange?: (health: VoiceRuntimeHealth) => void;
  /** How much proactive reporting the user asked for. */
  narrationDetail?: NarrationDetail;
}

export interface VoiceSession {
  phase: VoicePhase;
  enabled: boolean;
  /** True when the last reply was cut short by the user. */
  interrupted: boolean;
  /** A user-actionable capture, recognition or synthesis failure. */
  error: string | null;
  /** Compatibility fields used by the current compact Stage status line. */
  modelStatus: "unloaded" | "loading" | "ready";
  modelLoadProgress: number;
  /** Full backend qualification for a diagnostics or hardware surface. */
  health: VoiceRuntimeHealth;
  toggle: () => void;
  /**
   * Speak a main-process milestone without a user turn. Returns what was
   * decided so the caller can still record a deferred or muted update in the
   * transcript.
   */
  announce: (
    narration: ProactiveNarrationInput,
    overrides?: { detail?: NarrationDetail },
  ) => NarrationDecision;
}

const PROACTIVE_GROUP = "marta-proactive";
/** One screenful of held updates; older ones are stale by the time they play. */
const MAX_DEFERRED_NARRATIONS = 12;

const EMPTY_NARRATION_HEALTH: NarrationHealth = {
  active: false,
  queued: 0,
  currentPriority: null,
};

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  error.name === "AbortError";

const turnGroup = (generation: number): string => `voice-turn:${generation}`;

export function useVoiceSession(options: VoiceSessionOptions): VoiceSession {
  const whisper = useWhisperTranscription();
  const whisperRef = useRef(whisper);
  whisperRef.current = whisper;

  const [phase, setPhase] = useState<VoicePhase>("off");
  const [interrupted, setInterrupted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [microphoneHealth, setMicrophoneHealth] = useState<MicrophoneHealth>({
    ...CLOSED_MICROPHONE_HEALTH,
  });
  const [narrationHealth, setNarrationHealth] = useState<NarrationHealth>(
    EMPTY_NARRATION_HEALTH,
  );
  const [backendHealthVersion, setBackendHealthVersion] = useState(0);

  const mountedRef = useRef(true);
  const stateRef = useRef<VoiceState>(INITIAL_VOICE_STATE);
  const micRef = useRef<VoiceCaptureSession | null>(null);
  const openingRef = useRef(false);
  const desiredEnabledRef = useRef(false);
  const micAttemptRef = useRef(0);
  const asrAbortRef = useRef<AbortController | null>(null);
  const speechAbortRef = useRef<AbortController | null>(null);
  /** Stale transcription/model completions are ignored after this changes. */
  const generationRef = useRef(0);

  const onUtteranceRef = useRef(options.onUtterance);
  onUtteranceRef.current = options.onUtterance;
  const onCancelTurnRef = useRef(options.onCancelTurn);
  onCancelTurnRef.current = options.onCancelTurn;
  const onTranscriptUpdateRef = useRef(options.onTranscriptUpdate);
  onTranscriptUpdateRef.current = options.onTranscriptUpdate;
  const onHealthChangeRef = useRef(options.onHealthChange);
  onHealthChangeRef.current = options.onHealthChange;
  const narrationDetailRef = useRef<NarrationDetail>(
    options.narrationDetail ?? "normal",
  );
  narrationDetailRef.current = options.narrationDetail ?? "normal";
  /** Milestones that arrived while the user was mid-sentence. */
  const deferredRef = useRef<ProactiveNarrationInput[]>([]);

  const defaultAsrRef = useRef<AsrBackend | null>(null);
  if (!defaultAsrRef.current) {
    defaultAsrRef.current = createWhisperAsrBackend({
      getModelStatus: () => whisperRef.current.modelStatus,
      getModelLoadProgress: () => whisperRef.current.modelLoadProgress,
      warmUp: () => whisperRef.current.warmUp(),
      transcribe: (audio) => whisperRef.current.transcribe(audio),
    });
  }
  const asrRef = useRef<AsrBackend>(
    options.asrBackend ?? defaultAsrRef.current,
  );

  const ttsRef = useRef<TtsEngine>(options.ttsEngine ?? createTtsEngine());
  const narrationRef = useRef<NarrationQueue | null>(null);
  if (!narrationRef.current) {
    narrationRef.current = new NarrationQueue(ttsRef.current, (next) => {
      if (mountedRef.current) setNarrationHealth(next);
    });
  }

  /** Feed one event through the machine and run the requested effects. */
  const dispatch = useCallback((event: VoiceEvent) => {
    const mic = micRef.current;
    const before = stateRef.current;
    const { state, effects } = reduce(before, event, DEFAULT_TUNING);
    stateRef.current = state;

    if (mountedRef.current && state.phase !== before.phase)
      setPhase(state.phase);
    if (mountedRef.current && state.interrupted !== before.interrupted) {
      setInterrupted(state.interrupted);
    }

    for (const effect of effects) {
      switch (effect.type) {
        case "start-capture":
          mic?.startCapture();
          break;

        case "discard-capture":
          mic?.discardCapture();
          break;

        case "stop-speaking": {
          const group = turnGroup(generationRef.current);
          speechAbortRef.current?.abort();
          narrationRef.current?.cancelGroup(group);
          ttsRef.current.cancel();
          break;
        }

        case "cancel-transcription":
          generationRef.current += 1;
          asrAbortRef.current?.abort();
          asrAbortRef.current = null;
          break;

        case "cancel-turn": {
          const cancelledGeneration = generationRef.current;
          generationRef.current += 1;
          asrAbortRef.current?.abort();
          speechAbortRef.current?.abort();
          narrationRef.current?.cancelGroup(turnGroup(cancelledGeneration));
          ttsRef.current.cancel();
          void onCancelTurnRef.current?.();
          break;
        }

        case "end-capture": {
          if (!mic) break;
          const longEnough = isUtteranceLongEnough(mic.capturedFrames);
          const blob = mic.endCapture();
          if (!blob || !longEnough) {
            dispatch({ type: "transcribed", text: "" });
            break;
          }

          const generation = ++generationRef.current;
          const controller = new AbortController();
          asrAbortRef.current?.abort();
          asrAbortRef.current = controller;
          void asrRef.current
            .transcribe(blob, {
              signal: controller.signal,
              onTranscript: (update) => {
                if (generation !== generationRef.current) return;
                onTranscriptUpdateRef.current?.(update);
              },
            })
            .then((result) => {
              if (generation !== generationRef.current) return;
              dispatch({ type: "transcribed", text: result.text });
            })
            .catch((transcriptionError: unknown) => {
              if (generation !== generationRef.current) return;
              if (!isAbortError(transcriptionError) && mountedRef.current) {
                const detail =
                  transcriptionError instanceof Error
                    ? transcriptionError.message
                    : String(transcriptionError);
                setError(`Speech recognition failed: ${detail}`);
              }
              dispatch({ type: "transcribed", text: "" });
            })
            .finally(() => {
              if (asrAbortRef.current === controller)
                asrAbortRef.current = null;
              if (mountedRef.current)
                setBackendHealthVersion((value) => value + 1);
            });
          break;
        }

        case "send-turn": {
          const generation = generationRef.current;
          const groupId = turnGroup(generation);
          const controller = new AbortController();
          speechAbortRef.current?.abort();
          speechAbortRef.current = controller;
          let narrationStarted = false;
          let pendingSpeech = "";
          let streamedText = "";
          const speechJobs: Array<Promise<unknown>> = [];

          const startNarration = () => {
            if (narrationStarted || generation !== generationRef.current)
              return;
            narrationStarted = true;
            dispatch({ type: "reply-started" });
          };

          const enqueue = (chunks: string[]) => {
            if (chunks.length === 0) return;
            startNarration();
            for (const chunk of chunks) {
              speechJobs.push(
                narrationRef.current!.enqueue(chunk, {
                  groupId,
                  priority: "interactive",
                  signal: controller.signal,
                  interruptLowerPriority: true,
                }),
              );
            }
          };

          void onUtteranceRef
            .current(effect.text, {
              onReplyStarted: startNarration,
              onTextDelta: (text) => {
                if (generation !== generationRef.current) return;
                streamedText += text;
                pendingSpeech += text;
                const next = takeStreamingSpeechChunks(pendingSpeech);
                pendingSpeech = next.remainder;
                enqueue(next.chunks);
              },
            })
            .then(async (reply) => {
              if (generation !== generationRef.current) return;
              const final = takeStreamingSpeechChunks(pendingSpeech, {
                final: true,
              });
              pendingSpeech = final.remainder;
              enqueue(final.chunks);
              // A non-streaming server still receives exactly one spoken pass.
              if (!streamedText && reply.trim()) {
                enqueue(
                  takeStreamingSpeechChunks(reply, { final: true }).chunks,
                );
              }
              await Promise.all(speechJobs);
              if (generation !== generationRef.current) return;
              if (speechAbortRef.current === controller) {
                speechAbortRef.current = null;
              }
              dispatch({ type: "reply-finished" });
            })
            .catch(() => {
              if (generation !== generationRef.current) return;
              narrationRef.current?.cancelGroup(groupId);
              if (speechAbortRef.current === controller) {
                speechAbortRef.current = null;
              }
              dispatch({ type: "reply-failed" });
            });
          break;
        }
      }
    }
    // All mutable dependencies are intentionally read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFrame = useCallback(
    (frame: Float32Array) => {
      const phaseNow = stateRef.current.phase;
      if (phaseNow === "off") return;

      const speaking = phaseNow === "speaking";
      // A device that explicitly lacks AEC would hear Marta's own speakers.
      // Keep listening for the next turn, but require a button stop instead of
      // promising unsafe acoustic barge-in on that hardware.
      const canUseFrame = !speaking || (micRef.current?.isBargeInSafe ?? false);
      if (speaking && !canUseFrame) {
        // `MicSession` records pre-roll before it reports a frame. Do not carry
        // Marta's own loudspeaker tail into the user's next utterance when the
        // device explicitly lacks acoustic echo cancellation.
        micRef.current?.discardCapture();
      }
      dispatch({
        type: "frame",
        speech: canUseFrame && detectFrame(frame, { ducked: speaking }),
      });
    },
    [dispatch],
  );

  const enableRef = useRef<() => Promise<void>>(async () => {});
  const enable = useCallback(async () => {
    desiredEnabledRef.current = true;
    if (openingRef.current || micRef.current?.isOpen) return;

    const attempt = ++micAttemptRef.current;
    openingRef.current = true;
    if (mountedRef.current) setError(null);
    void Promise.resolve(asrRef.current.warmUp()).catch(() => {});

    const createMic =
      options.createMicSession ?? ((micOptions) => new MicSession(micOptions));
    const mic = createMic({
      onFrame: handleFrame,
      onError: (micError) => {
        if (mountedRef.current) setError(micError.message);
      },
      onHealthChange: (next) => {
        if (mountedRef.current) setMicrophoneHealth(next);
        if (next.state === "error" && stateRef.current.phase !== "off") {
          desiredEnabledRef.current = false;
          dispatch({ type: "disable" });
          const failedMic = micRef.current;
          micRef.current = null;
          void failedMic?.close();
        }
      },
    });
    micRef.current = mic;

    try {
      await mic.open();
      if (
        !desiredEnabledRef.current ||
        attempt !== micAttemptRef.current ||
        micRef.current !== mic
      ) {
        await mic.close();
        if (micRef.current === mic) micRef.current = null;
        return;
      }
      if (mountedRef.current) setMicrophoneHealth(mic.getHealth());
      dispatch({ type: "enable" });
    } catch (openError) {
      await mic.close();
      if (micRef.current === mic) micRef.current = null;
      const superseded =
        !desiredEnabledRef.current || attempt !== micAttemptRef.current;
      if (!superseded && !isAbortError(openError) && mountedRef.current) {
        const detail =
          openError instanceof Error ? openError.message : String(openError);
        setError(`Microphone unavailable: ${detail}`);
      }
    } finally {
      openingRef.current = false;
      // Handles the sequence enable → disable → enable while getUserMedia is
      // still pending. The cancelled attempt cleans itself up, then converges
      // on the final requested state.
      if (desiredEnabledRef.current && !micRef.current) {
        queueMicrotask(() => void enableRef.current());
      }
    }
  }, [dispatch, handleFrame, options.createMicSession]);
  enableRef.current = enable;

  const disable = useCallback(async () => {
    desiredEnabledRef.current = false;
    micAttemptRef.current += 1;
    dispatch({ type: "disable" });
    asrAbortRef.current?.abort();
    asrAbortRef.current = null;
    speechAbortRef.current?.abort();
    speechAbortRef.current = null;
    narrationRef.current?.cancelAll();
    // Held milestones are dropped rather than kept: re-enabling the mic minutes
    // later should not replay what was happening then.
    deferredRef.current.length = 0;

    const mic = micRef.current;
    micRef.current = null;
    await mic?.close();
    if (mountedRef.current)
      setMicrophoneHealth(mic?.getHealth() ?? CLOSED_MICROPHONE_HEALTH);
  }, [dispatch]);

  const toggle = useCallback(() => {
    if (desiredEnabledRef.current || stateRef.current.phase !== "off") {
      void disable();
    } else {
      void enable();
    }
  }, [disable, enable]);

  /**
   * Say something the user did not ask for, right now.
   *
   * The whole point of the durable event ledger is that Marta can report real
   * progress without a user turn, so this deliberately does *not* go through
   * `send()`: there is no inference here, only a sentence main already wrote.
   *
   * `background` priority is what makes this safe next to a live conversation:
   * `NarrationQueue` sorts an interactive reply ahead of it, so a status line
   * can never delay an answer to a question.
   */
  const announce = useCallback(
    (
      narration: ProactiveNarrationInput,
      overrides: { detail?: NarrationDetail } = {},
    ): NarrationDecision => {
      const decision = decideNarration(narration, {
        detail: overrides.detail ?? narrationDetailRef.current,
        phase: stateRef.current.phase,
        voiceEnabled:
          desiredEnabledRef.current || stateRef.current.phase !== "off",
      });

      if (decision.defer) {
        deferredRef.current.push(narration);
        // Bounded: a ten-minute monologue while the user talks is not a feature.
        // `collapseDeferred` keeps the newest per task, so the cap only ever
        // discards updates that were already superseded.
        if (deferredRef.current.length > MAX_DEFERRED_NARRATIONS) {
          deferredRef.current.splice(
            0,
            deferredRef.current.length - MAX_DEFERRED_NARRATIONS,
          );
        }
        return decision;
      }
      if (!decision.speak) return decision;

      void narrationRef.current?.enqueue(narration.text, {
        priority: decision.queuePriority,
        groupId: PROACTIVE_GROUP,
        interruptLowerPriority: decision.interruptLowerPriority,
      });
      return decision;
    },
    [],
  );

  /**
   * Flush what was held while the user had the floor.
   *
   * Driven by the phase transition rather than a timer: the moment the machine
   * leaves `capturing`/`transcribing` is exactly when speaking is safe again,
   * and a timer would either fire too early or add latency for no reason.
   */
  useEffect(() => {
    if (phase === "capturing" || phase === "transcribing") return;
    if (deferredRef.current.length === 0) return;
    const held = collapseDeferred(deferredRef.current.splice(0));
    for (const narration of held) {
      void narrationRef.current?.enqueue(narration.text, {
        priority: "background",
        groupId: PROACTIVE_GROUP,
      });
    }
  }, [phase]);

  useEffect(() => {
    void Promise.resolve(asrRef.current.warmUp()).catch(() => {});
  }, []);

  useEffect(() => {
    const backend = asrRef.current;
    return backend.subscribe?.(() =>
      setBackendHealthVersion((value) => value + 1),
    );
  }, []);

  const asrHealth = useMemo(
    () => asrRef.current.getHealth(),
    [whisper.modelStatus, whisper.modelLoadProgress, backendHealthVersion],
  );
  const ttsHealth = useMemo(
    () => ttsRef.current.getHealth(),
    [backendHealthVersion],
  );
  const health = useMemo(
    () =>
      summarizeVoiceRuntimeHealth({
        microphone: microphoneHealth,
        asr: asrHealth,
        tts: ttsHealth,
        narration: narrationHealth,
      }),
    [asrHealth, microphoneHealth, narrationHealth, ttsHealth],
  );

  useEffect(() => {
    onHealthChangeRef.current?.(health);
  }, [health]);

  useEffect(() => {
    // React StrictMode intentionally runs setup → cleanup → setup in
    // development. Reassert liveness here so the second, real setup can update
    // health and phase after the simulated cleanup.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      desiredEnabledRef.current = false;
      micAttemptRef.current += 1;
      generationRef.current += 1;
      asrAbortRef.current?.abort();
      speechAbortRef.current?.abort();
      narrationRef.current?.cancelAll();
      void micRef.current?.close();
      micRef.current = null;
    };
  }, []);

  const modelStatus = options.asrBackend
    ? asrHealth.status === "ready" || asrHealth.status === "degraded"
      ? "ready"
      : asrHealth.status === "warming"
        ? "loading"
        : "unloaded"
    : whisper.modelStatus;

  return {
    phase,
    enabled: desiredEnabledRef.current || phase !== "off",
    interrupted,
    error,
    modelStatus,
    modelLoadProgress: options.asrBackend
      ? modelStatus === "ready"
        ? 100
        : 0
      : whisper.modelLoadProgress,
    health,
    toggle,
    announce,
  };
}
