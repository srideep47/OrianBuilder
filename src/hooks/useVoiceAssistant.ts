/**
 * useVoiceAssistant
 *
 * Full voice-assistant loop:
 *   record → Whisper transcription (local, via Transformers.js) → pattern-matched reply → TTS
 *
 * No IPC, no Electron main-process, no cloud API calls for transcription.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import {
  buildAssistantReply,
  VoiceState,
  getInitialVoiceContext,
  type VoiceAssistantContext,
} from "@/lib/voiceAssistant";
import { useWhisperTranscription } from "./useWhisperTranscription";

interface UseVoiceAssistantOptions {
  enabled: boolean;
  onTranscription?: (text: string) => void;
  onError?: (error: string) => void;
}

export function useVoiceAssistant({
  enabled,
  onTranscription,
  onError,
}: UseVoiceAssistantOptions) {
  const [context, setContext] = useState<VoiceAssistantContext>(
    getInitialVoiceContext(),
  );

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const skipOnStopRef = useRef(false);
  // Marks an intentional stop so onstop still runs transcription.
  const isStoppingRef = useRef(false);

  const { modelStatus, modelLoadProgress, warmUp, transcribe } =
    useWhisperTranscription();

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const stopMediaStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const stopSpeech = useCallback(() => {
    window.speechSynthesis.cancel();
    setContext((prev) => ({
      ...prev,
      state: prev.state === VoiceState.SPEAKING ? VoiceState.IDLE : prev.state,
      statusMessage: "Speech stopped.",
    }));
  }, []);

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      skipOnStopRef.current = true;
      const rec = mediaRecorderRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
      mediaRecorderRef.current = null;
      stopMediaStream();
      stopSpeech();
      chunksRef.current = [];
    };
  }, [stopMediaStream, stopSpeech]);

  // Keep the status message in sync with the Whisper model loading progress
  // so the modal's status area gives live feedback during the first download.
  useEffect(() => {
    if (modelStatus === "loading") {
      setContext((prev) =>
        prev.state === VoiceState.PROCESSING
          ? {
              ...prev,
              statusMessage: `Loading Whisper model… ${modelLoadProgress}%`,
            }
          : prev,
      );
    }
  }, [modelStatus, modelLoadProgress]);

  // ─── Recording ────────────────────────────────────────────────────────────

  const startListening = useCallback(async () => {
    if (
      context.state === VoiceState.PROCESSING ||
      context.state === VoiceState.SPEAKING
    ) {
      return;
    }
    if (!enabled) return;

    try {
      setContext((prev) => ({
        ...prev,
        userText: "",
        assistantText: "",
        state: VoiceState.IDLE,
        statusMessage: "Starting microphone…",
      }));

      // Pre-warm the Whisper model while the user is still about to speak —
      // this way the first-time download often finishes before recording ends.
      warmUp();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm",
      });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        mediaRecorderRef.current = null;
        stopMediaStream();

        const wasStopping = isStoppingRef.current;
        isStoppingRef.current = false;

        if (skipOnStopRef.current) {
          chunksRef.current = [];
          return;
        }

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        chunksRef.current = [];

        if (blob.size === 0) {
          // Nothing recorded — reset to IDLE whether it was an intentional stop or not.
          setContext((prev) =>
            prev.state !== VoiceState.IDLE
              ? {
                  ...prev,
                  state: VoiceState.IDLE,
                  statusMessage: "Stopped. Ready when you are.",
                }
              : prev,
          );
          return;
        }

        // Mark as processing AFTER confirming there is audio to transcribe.
        void wasStopping; // acknowledged; same code path regardless
        setContext((prev) => ({
          ...prev,
          state: VoiceState.PROCESSING,
          statusMessage:
            modelStatus === "loading"
              ? `Loading Whisper model… ${modelLoadProgress}%`
              : "Transcribing speech…",
        }));

        try {
          // All-in-one: load model (if needed) + decode audio + run Whisper.
          const transcribedText = await transcribe(blob);

          if (transcribedText) {
            setContext((prev) => ({ ...prev, userText: transcribedText }));
            onTranscription?.(transcribedText);

            const assistantReply = buildAssistantReply(transcribedText);
            setContext((prev) => ({
              ...prev,
              assistantText: assistantReply,
              state: VoiceState.IDLE,
              statusMessage: "Reply ready. Tap Sound to hear it.",
            }));
          } else {
            setContext((prev) => ({
              ...prev,
              state: VoiceState.IDLE,
              statusMessage: "I did not catch that. Try again.",
            }));
          }
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Transcription failed";
          setContext((prev) => ({
            ...prev,
            state: VoiceState.IDLE,
            statusMessage: message,
          }));
          onError?.(message);
        }
      };

      mediaRecorder.start();
      setContext((prev) => ({
        ...prev,
        state: VoiceState.LISTENING,
        statusMessage: "Listening… speak now.",
      }));
    } catch (err) {
      stopMediaStream();
      const message =
        err instanceof Error ? err.message : "Failed to access microphone";
      setContext((prev) => ({
        ...prev,
        state: VoiceState.IDLE,
        statusMessage: message,
      }));
      onError?.(message);
    }
    // NOTE: modelStatus / modelLoadProgress are read inside the onstop closure
    // via the snapshot captured at call time; they are intentionally omitted
    // from this dep array to avoid re-creating the callback on every progress tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    context.state,
    onTranscription,
    onError,
    stopMediaStream,
    warmUp,
    transcribe,
  ]);

  const stopListening = useCallback(() => {
    isStoppingRef.current = true;

    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.stop(); // triggers onstop → transcription
      return;
    }

    // Nothing was recording; just reset UI.
    isStoppingRef.current = false;
    setContext((prev) => ({
      ...prev,
      state: VoiceState.IDLE,
      statusMessage: "Stopped. Ready when you are.",
    }));
  }, []);

  const toggleRecording = useCallback(async () => {
    if (context.state === VoiceState.LISTENING) {
      if (!isStoppingRef.current) stopListening();
      return;
    }
    if (
      context.state === VoiceState.PROCESSING ||
      context.state === VoiceState.SPEAKING
    ) {
      return;
    }
    if (isStoppingRef.current) return;
    await startListening();
  }, [context.state, startListening, stopListening]);

  // ─── TTS ──────────────────────────────────────────────────────────────────

  const speakReply = useCallback(async () => {
    if (!context.assistantText.trim()) {
      setContext((prev) => ({
        ...prev,
        statusMessage: "There is no assistant reply to speak yet.",
      }));
      return;
    }

    try {
      window.speechSynthesis.cancel();

      setContext((prev) => ({
        ...prev,
        state: VoiceState.SPEAKING,
        statusMessage: "Speaking response…",
      }));

      const utterance = new SpeechSynthesisUtterance(context.assistantText);
      utterance.rate = 0.9;
      utterance.pitch = 1.0;
      utterance.lang = "en-US";

      utterance.onend = () => {
        setContext((prev) => ({
          ...prev,
          state: VoiceState.IDLE,
          statusMessage: "Ready to listen.",
        }));
      };

      utterance.onerror = (event) => {
        const errorMsg = `TTS error: ${event.error}`;
        setContext((prev) => ({
          ...prev,
          state: VoiceState.IDLE,
          statusMessage: errorMsg,
        }));
        onError?.(errorMsg);
      };

      window.speechSynthesis.speak(utterance);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to speak response";
      setContext((prev) => ({
        ...prev,
        state: VoiceState.IDLE,
        statusMessage: message,
      }));
      onError?.(message);
    }
  }, [context.assistantText, onError]);

  // ─── Controls ─────────────────────────────────────────────────────────────

  const clearConversation = useCallback(() => {
    window.speechSynthesis.cancel();
    setContext(getInitialVoiceContext());
  }, []);

  const stopAllAudio = useCallback(() => {
    stopListening();
    stopSpeech();
  }, [stopListening, stopSpeech]);

  // ─── Return ───────────────────────────────────────────────────────────────

  return {
    context,
    isRecording: context.state === VoiceState.LISTENING,
    // PROCESSING covers both Whisper model loading and actual inference.
    isTranscribing: context.state === VoiceState.PROCESSING,
    isSpeaking: context.state === VoiceState.SPEAKING,
    toggleRecording,
    speakReply,
    clearConversation,
    stopAllAudio,
  };
}
