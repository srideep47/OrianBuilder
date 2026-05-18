import { useState, useRef, useCallback, useEffect } from "react";
import { ipc } from "@/ipc/types";
import { v4 as uuidv4 } from "uuid";
import {
  buildAssistantReply,
  VoiceState,
  getInitialVoiceContext,
  type VoiceAssistantContext,
} from "@/lib/voiceAssistant";
import { useSettings } from "@/hooks/useSettings";

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
  const skipOnStopProcessingRef = useRef(false);
  const isStoppingRef = useRef(false);
  const synthRef = useRef<SpeechSynthesisUtterance | null>(null);
  const { settings } = useSettings();
  const recognitionRef = useRef<any>(null);

  const stopMediaStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const stopSpeech = useCallback(() => {
    window.speechSynthesis.cancel();
    setContext((prev) => ({
      ...prev,
      state: prev.state === VoiceState.SPEAKING ? VoiceState.IDLE : prev.state,
      statusMessage: "Speech stopped.",
    }));
  }, []);

  useEffect(() => {
    return () => {
      skipOnStopProcessingRef.current = true;
      const mediaRecorder = mediaRecorderRef.current;
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
      mediaRecorderRef.current = null;
      if (recognitionRef.current) {
        recognitionRef.current.stop();
        recognitionRef.current = null;
      }
      stopMediaStream();
      stopSpeech();
      chunksRef.current = [];
    };
  }, [stopMediaStream, stopSpeech]);

  const startListening = useCallback(async () => {
    if (context.state === VoiceState.PROCESSING || context.state === VoiceState.SPEAKING) {
      return;
    }

    if (!enabled) return;

    try {
      setContext((prev) => ({
        ...prev,
        userText: "",
        assistantText: "",
        state: VoiceState.IDLE,
        statusMessage: "Starting microphone...",
      }));

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: "audio/webm",
      });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        mediaRecorderRef.current = null;
        stopMediaStream();

        const wasStopping = isStoppingRef.current;
        isStoppingRef.current = false;

        if (skipOnStopProcessingRef.current) {
          chunksRef.current = [];
          return;
        }

        // If we stopped intentionally, we may still want to run transcription
        // so the recognized speech can be inserted by callers.
        // (Previously we discarded transcription here, which broke mic toggle.)
        if (wasStopping) {
          // keep chunks for transcription; just normalize UI status
          setContext((prev) => ({
            ...prev,
            state: VoiceState.PROCESSING,
            statusMessage: "Processing speech...",
          }));
        }

        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        chunksRef.current = [];

        if (blob.size === 0) {
          return;
        }

        setContext((prev) => ({
          ...prev,
          state: VoiceState.PROCESSING,
          statusMessage: "Processing speech...",
        }));

        try {
          const arrayBuffer = await blob.arrayBuffer();
          const hasProviderKey = !!settings?.providerSettings?.auto?.apiKey?.value;
          let transcribedText = "";

          if (hasProviderKey) {
            const audioData = Array.from(new Uint8Array(arrayBuffer));
            const result = await ipc.audio.transcribeAudio({
              audioData,
              filename: "recording.webm",
              requestId: uuidv4(),
            });
            transcribedText = result.text.trim();
          } else {
            // Convert ArrayBuffer to Base64 for Gemini API
            let binary = '';
            const bytes = new Uint8Array(arrayBuffer);
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            const base64Audio = window.btoa(binary);

            const geminiKey = "AIzaSyA7CqpUWshpfdDrBMCTRsepDk3I_dD2pXI";
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{
                  parts: [
                    { text: "Please transcribe the following audio exactly as spoken. Return only the transcription, nothing else." },
                    { inlineData: { mimeType: "audio/webm", data: base64Audio } }
                  ]
                }]
              })
            });

            if (!res.ok) {
               throw new Error(`Gemini transcription failed: ${res.statusText}`);
            }

            const data = await res.json();
            transcribedText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
          }

          if (transcribedText) {
            setContext((prev) => ({
              ...prev,
              userText: transcribedText,
            }));

            onTranscription?.(transcribedText);

            // Generate assistant reply
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
        statusMessage: "Listening...",
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
  }, [enabled, context.state, onTranscription, onError, stopMediaStream, settings]);

  const stopListening = useCallback(() => {
    isStoppingRef.current = true;

    if (recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }

    const mediaRecorder = mediaRecorderRef.current;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      isStoppingRef.current = true;
      mediaRecorder.stop();
      return;
    }

    // If there's no recorder / it's already inactive, just normalize UI.
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

    if (context.state === VoiceState.PROCESSING || context.state === VoiceState.SPEAKING) {
      return;
    }

    if (isStoppingRef.current) return;
    await startListening();
  }, [context.state, startListening, stopListening]);

  const speakReply = useCallback(async () => {
    if (!context.assistantText.trim()) {
      setContext((prev) => ({
        ...prev,
        statusMessage: "There is no assistant reply to speak yet.",
      }));
      return;
    }

    try {
      // Stop any ongoing speech
      window.speechSynthesis.cancel();

      setContext((prev) => ({
        ...prev,
        state: VoiceState.SPEAKING,
        statusMessage: "Speaking response...",
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

      synthRef.current = utterance;
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

  const clearConversation = useCallback(() => {
    window.speechSynthesis.cancel();
    setContext(getInitialVoiceContext());
  }, []);

  const stopAllAudio = useCallback(() => {
    stopListening();
    stopSpeech();
  }, [stopListening, stopSpeech]);

  return {
    context,
    isRecording: context.state === VoiceState.LISTENING,
    isTranscribing: context.state === VoiceState.PROCESSING,
    isSpeaking: context.state === VoiceState.SPEAKING,
    toggleRecording,
    speakReply,
    clearConversation,
    stopAllAudio,
  };
}
