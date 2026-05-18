import { useState, useRef, useCallback, useEffect } from "react";
import { ipc } from "@/ipc/types";
import { v4 as uuidv4 } from "uuid";

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
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const skipProcessingRef = useRef(false);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

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
    if (isTranscribing) return;

    if (isRecording) {
      mediaRecorderRef.current?.stop();
      return;
    }

    if (!enabled) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

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

        if (skipProcessingRef.current) {
          chunksRef.current = [];
          return;
        }

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        chunksRef.current = [];
        if (blob.size === 0) return;

        setIsTranscribing(true);
        try {
          const arrayBuffer = await blob.arrayBuffer();
          const result = await ipc.audio.transcribeAudio({
            audioData: Array.from(new Uint8Array(arrayBuffer)),
            filename: "recording.webm",
            requestId: uuidv4(),
          });
          const text = result.text.trim();
          if (text) onTranscription(text);
          else onError?.("No speech detected. Please try again.");
        } catch (err) {
          onError?.(
            err instanceof Error ? err.message : "Transcription failed",
          );
        } finally {
          setIsTranscribing(false);
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
  ]);

  return { isRecording, isTranscribing, toggleRecording };
}
