/**
 * useVoiceToText
 *
 * Records microphone audio and transcribes it locally using Transformers.js
 * (Whisper tiny.en).  No IPC calls, no cloud API keys, no Electron backend.
 *
 * The hook exposes the same { isRecording, isTranscribing, toggleRecording }
 * interface as before so callers (ChatInput, HomeChatInput) need no changes.
 * Extra fields (modelStatus, modelLoadProgress) are available for richer UI.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useWhisperTranscription } from "./useWhisperTranscription";

interface UseVoiceToTextOptions {
  enabled?: boolean;
  onTranscription: (text: string) => void;
  onError?: (error: string) => void;
}

export function useVoiceToText({
  enabled = true,
  onTranscription,
  onError,
}: UseVoiceToTextOptions) {
  const [isRecording, setIsRecording] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // Set to true on unmount so a pending onstop callback is skipped.
  const skipProcessingRef = useRef(false);

  const { modelStatus, modelLoadProgress, isTranscribing, warmUp, transcribe } =
    useWhisperTranscription();

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Cleanup on unmount: stop any active recording and release the mic.
  useEffect(() => {
    return () => {
      skipProcessingRef.current = true;
      const rec = mediaRecorderRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
      mediaRecorderRef.current = null;
      stopStream();
      chunksRef.current = [];
    };
  }, [stopStream]);

  const toggleRecording = useCallback(async () => {
    // Block new recordings while Whisper is working.
    if (isTranscribing) return;

    // Second click while recording → stop and transcribe.
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      return;
    }

    if (!enabled) return;

    // Kick off model download in the background the moment the user taps the
    // mic so that by the time they finish speaking it may already be cached.
    warmUp();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // audio/webm is universally supported in Chromium (Electron's renderer).
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm",
      });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      skipProcessingRef.current = false;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        mediaRecorderRef.current = null;
        stopStream();
        setIsRecording(false);

        // Bail out if the component unmounted while we were recording.
        if (skipProcessingRef.current) {
          chunksRef.current = [];
          return;
        }

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        chunksRef.current = [];
        if (blob.size === 0) return;

        try {
          // transcribe() handles: model loading → audio decode → Whisper inference.
          // isTranscribing from the hook flips to true for the entire duration,
          // giving callers a single boolean to drive their loading UI.
          const text = await transcribe(blob);

          if (text) {
            onTranscription(text);
          } else {
            onError?.("No speech detected. Please try again.");
          }
        } catch (err) {
          onError?.(
            err instanceof Error ? err.message : "Transcription failed",
          );
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      stopStream();
      onError?.(
        err instanceof Error ? err.message : "Failed to access microphone",
      );
    }
  }, [
    enabled,
    isRecording,
    isTranscribing,
    onTranscription,
    onError,
    stopStream,
    warmUp,
    transcribe,
  ]);

  return {
    isRecording,
    // Expose combined loading state: model loading counts as "transcribing"
    // from the caller's perspective so the spinner appears immediately.
    isTranscribing: isTranscribing || modelStatus === "loading",
    // Extra fields for richer UIs (tooltip text, progress bar, etc.)
    modelStatus,
    modelLoadProgress,
    toggleRecording,
  };
}
