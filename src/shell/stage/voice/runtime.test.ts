import { describe, expect, it } from "vitest";

import {
  CLOSED_MICROPHONE_HEALTH,
  summarizeVoiceRuntimeHealth,
  type VoiceBackendHealth,
} from "./runtime";

const backend = (
  kind: "asr" | "tts",
  status: VoiceBackendHealth["status"],
  streaming = true,
): VoiceBackendHealth => ({
  descriptor: {
    id: kind,
    label: kind,
    kind,
    execution: "browser",
  },
  status,
  supportsStreaming: streaming,
  supportsCancellation: true,
  checkedAt: 1,
});

describe("summarizeVoiceRuntimeHealth", () => {
  it("keeps text conversation available when only speech output is absent", () => {
    const result = summarizeVoiceRuntimeHealth({
      microphone: {
        ...CLOSED_MICROPHONE_HEALTH,
        echoControl: "active",
      },
      asr: backend("asr", "ready"),
      tts: backend("tts", "unavailable"),
      narration: { active: false, queued: 0, currentPriority: null },
    });
    expect(result.status).toBe("degraded");
    expect(result.limitations.join(" ")).toMatch(/Spoken replies/i);
  });

  it("marks voice input unavailable when ASR fails", () => {
    const result = summarizeVoiceRuntimeHealth({
      microphone: CLOSED_MICROPHONE_HEALTH,
      asr: { ...backend("asr", "error"), detail: "ASR crashed." },
      tts: backend("tts", "ready"),
      narration: { active: false, queued: 0, currentPriority: null },
    });
    expect(result.status).toBe("unavailable");
    expect(result.limitations).toContain("ASR crashed.");
  });
});
