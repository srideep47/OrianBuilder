/**
 * Shared contracts for Marta's replaceable voice backends.
 *
 * The browser implementations are deliberately just one qualified backend.
 * A future Qwen/Whisper/Piper sidecar can implement the same contracts without
 * changing turn-taking, the Stage, or the narration scheduler.
 */

export type VoiceBackendStatus =
  | "unavailable"
  | "cold"
  | "warming"
  | "ready"
  | "degraded"
  | "error";

export interface VoiceBackendDescriptor {
  id: string;
  label: string;
  kind: "asr" | "tts";
  execution: "browser" | "local-process" | "remote";
  model?: string;
}

export interface VoiceBackendHealth {
  descriptor: VoiceBackendDescriptor;
  status: VoiceBackendStatus;
  detail?: string;
  /** The backend can emit useful, revisable text before final endpointing. */
  supportsStreaming: boolean;
  /** Work is actually stopped, rather than merely having its result ignored. */
  supportsCancellation: boolean;
  checkedAt: number;
}

export type MicrophoneLifecycle =
  | "closed"
  | "opening"
  | "open"
  | "closing"
  | "error";

export type EchoControlStatus = "active" | "unverified" | "unavailable";

export interface MicrophoneHealth {
  state: MicrophoneLifecycle;
  echoControl: EchoControlStatus;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  sampleRate: number | null;
  deviceLabel?: string;
  detail?: string;
  checkedAt: number;
}

export interface NarrationHealth {
  active: boolean;
  queued: number;
  currentPriority: NarrationPriority | null;
}

export type NarrationPriority =
  | "background"
  | "status"
  | "interactive"
  | "critical";

export interface VoiceRuntimeHealth {
  status: "ready" | "warming" | "degraded" | "unavailable";
  microphone: MicrophoneHealth;
  asr: VoiceBackendHealth;
  tts: VoiceBackendHealth;
  narration: NarrationHealth;
  limitations: string[];
}

export const CLOSED_MICROPHONE_HEALTH: MicrophoneHealth = {
  state: "closed",
  echoControl: "unverified",
  noiseSuppression: null,
  autoGainControl: null,
  sampleRate: null,
  checkedAt: 0,
};

/** A stable summary suitable for a diagnostics surface or telemetry snapshot. */
export function summarizeVoiceRuntimeHealth(input: {
  microphone: MicrophoneHealth;
  asr: VoiceBackendHealth;
  tts: VoiceBackendHealth;
  narration: NarrationHealth;
}): VoiceRuntimeHealth {
  const limitations: string[] = [];

  if (input.asr.status === "unavailable" || input.asr.status === "error") {
    limitations.push(input.asr.detail ?? "Speech recognition is unavailable.");
  } else if (input.asr.status === "degraded" && input.asr.detail) {
    limitations.push(input.asr.detail);
  }
  if (input.tts.status === "unavailable" || input.tts.status === "error") {
    limitations.push(
      input.tts.detail ?? "Spoken replies are unavailable; text still works.",
    );
  } else if (input.tts.status === "degraded" && input.tts.detail) {
    limitations.push(input.tts.detail);
  }
  if (input.microphone.state === "error") {
    limitations.push(
      input.microphone.detail ?? "The microphone is unavailable.",
    );
  }
  if (input.microphone.echoControl === "unavailable") {
    limitations.push(
      "Hardware echo cancellation is unavailable; acoustic barge-in is disabled to prevent self-interruption.",
    );
  } else if (input.microphone.echoControl === "unverified") {
    limitations.push(
      "The microphone did not report whether echo cancellation is active.",
    );
  }
  if (!input.asr.supportsStreaming) {
    limitations.push(
      "The active speech recognizer returns endpointed transcripts rather than live partials.",
    );
  }

  let status: VoiceRuntimeHealth["status"] = "ready";
  if (
    input.microphone.state === "opening" ||
    input.microphone.state === "closing" ||
    input.asr.status === "warming" ||
    input.asr.status === "cold"
  ) {
    status = "warming";
  }
  if (
    input.tts.status === "degraded" ||
    input.tts.status === "unavailable" ||
    input.microphone.echoControl === "unavailable" ||
    input.asr.status === "degraded"
  ) {
    status = "degraded";
  }
  if (
    input.microphone.state === "error" ||
    input.asr.status === "unavailable" ||
    input.asr.status === "error"
  ) {
    status = "unavailable";
  }

  return { ...input, status, limitations };
}
