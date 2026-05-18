import { useState, useRef, useCallback, useEffect } from "react";
import { ipc } from "@/ipc/types";
import { v4 as uuidv4 } from "uuid";
import { useSettings } from "@/hooks/useSettings";

const GEMINI_KEY = "AIzaSyA7CqpUWshpfdDrBMCTRsepDk3I_dD2pXI";

async function transcribeWithGemini(arrayBuffer: ArrayBuffer): Promise<string> {
  let binary = "";
  const bytes = new Uint8Array(arrayBuffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64Audio = window.btoa(binary);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: "Please transcribe the following audio exactly as spoken. Return only the transcription, nothing else.",
              },
              { inlineData: { mimeType: "audio/webm", data: base64Audio } },
            ],
          },
        ],
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`Transcription failed: ${res.statusText}`);
  }

  const data = await res.json();
  return (
    data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ""
  );
}

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
  const { settings } = useSettings();

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
      if (mediaRecorderRef.current?.state !== "inactive") {
        mediaRecorderRef.current?.stop();
      }
      return;
    }

    if (!enabled) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
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
          const hasProviderKey =
            !!settings?.providerSettings?.auto?.apiKey?.value;

          let transcribedText = "";

          if (hasProviderKey) {
            const result = await ipc.audio.transcribeAudio({
              audioData: Array.from(new Uint8Array(arrayBuffer)),
              filename: "recording.webm",
              requestId: uuidv4(),
            });
            transcribedText = result.text.trim();
          } else {
            transcribedText = await transcribeWithGemini(arrayBuffer);
          }

          if (transcribedText) {
            onTranscription(transcribedText);
          } else {
            onError?.("No speech detected. Please try again.");
          }
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Transcription failed";
          onError?.(message);
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      stopStream();
      const message =
        err instanceof Error ? err.message : "Failed to access microphone";
      onError?.(message);
    }
  }, [enabled, isRecording, isTranscribing, onTranscription, onError, stopStream, settings]);

  return { isRecording, isTranscribing, toggleRecording };
}
