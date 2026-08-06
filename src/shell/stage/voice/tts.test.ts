import { describe, expect, it, vi } from "vitest";

import {
  chunkForSpeech,
  FallbackTtsEngine,
  selectPreferredVoice,
  SilentTts,
  takeStreamingSpeechChunks,
  type TtsEngine,
} from "./tts";

const voice = (
  name: string,
  lang: string,
  options: { localService?: boolean; default?: boolean } = {},
) =>
  ({
    name,
    lang,
    voiceURI: name,
    localService: options.localService ?? true,
    default: options.default ?? false,
  }) as SpeechSynthesisVoice;

describe("selectPreferredVoice", () => {
  it("prefers a neural English voice over a basic default voice", () => {
    const basic = voice("Microsoft David", "en-US", { default: true });
    const natural = voice("Microsoft Aria Online (Natural)", "en-US", {
      localService: false,
    });
    expect(selectPreferredVoice([basic, natural])).toBe(natural);
  });

  it("prefers a suitable English voice when no neural voice exists", () => {
    const hindi = voice("Hindi voice", "hi-IN", { default: true });
    const english = voice("Microsoft Zira", "en-US");
    expect(selectPreferredVoice([hindi, english])).toBe(english);
    expect(selectPreferredVoice([])).toBeNull();
  });

  it("honors an explicitly preferred language and voice name", () => {
    const natural = voice("Microsoft Aria Online (Natural)", "en-US");
    const chosen = voice("Microsoft Neerja", "en-IN");
    expect(
      selectPreferredVoice([natural, chosen], {
        language: "en-IN",
        preferredVoiceNames: ["Neerja"],
      }),
    ).toBe(chosen);
  });
});

describe("chunkForSpeech", () => {
  it("splits on sentence boundaries, never mid-sentence", () => {
    // A cap tight enough that only one sentence fits per chunk, so the split
    // point is observable. Packing is tested separately — the two behaviours
    // are the same rule seen at different lengths.
    expect(chunkForSpeech("Alpha one. Beta two. Gamma three.", 11)).toEqual([
      "Alpha one.",
      "Beta two.",
      "Gamma three.",
    ]);
    // And the split points are sentence ends, not arbitrary offsets.
    for (const chunk of chunkForSpeech("Alpha one. Beta two.", 11)) {
      expect(chunk.endsWith(".")).toBe(true);
    }
  });

  it("packs short sentences together rather than stuttering", () => {
    // One utterance per full stop would put an audible gap between every
    // clause of a two-line answer.
    expect(chunkForSpeech("Yes. Done. Anything else?")).toEqual([
      "Yes. Done. Anything else?",
    ]);
  });

  it("breaks an over-long sentence on a word boundary", () => {
    const long = `${"word ".repeat(80)}end.`;
    const chunks = chunkForSpeech(long, 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(60);
      // Never mid-word.
      expect(chunk).not.toMatch(/\bwor$|\bwo$/);
    }
    expect(chunks.join(" ")).toContain("end.");
  });

  it("does not read code aloud", () => {
    // Reading braces and semicolons is unlistenable, and the transcript still
    // shows the real thing.
    const chunks = chunkForSpeech(
      "Here you go:\n```ts\nconst x = {a: 1};\n```\nThat's it.",
    );
    const spoken = chunks.join(" ");
    expect(spoken).not.toContain("const");
    expect(spoken).toContain("code shown on screen");
    expect(spoken).toContain("That's it.");
  });

  it("strips markdown that is punctuation for the eye only", () => {
    const spoken = chunkForSpeech("**Bold** and `code` and _italic_.").join(
      " ",
    );
    expect(spoken).toBe("Bold and code and italic.");
  });

  it("drops list bullets", () => {
    const spoken = chunkForSpeech("- one\n- two\n- three").join(" ");
    expect(spoken).not.toContain("-");
    expect(spoken).toContain("one");
  });

  it("returns nothing for nothing", () => {
    expect(chunkForSpeech("")).toEqual([]);
    expect(chunkForSpeech("   \n  ")).toEqual([]);
    expect(chunkForSpeech("```\njust code\n```").join("")).toContain(
      "code shown on screen",
    );
  });
});

describe("SilentTts", () => {
  it("lets the turn loop run unchanged on a machine with no speech", () => {
    const tts = new SilentTts();
    expect(tts.isAvailable()).toBe(false);
    expect(tts.isSpeaking()).toBe(false);
    return expect(tts.speak()).resolves.toBeUndefined();
  });
});

describe("FallbackTtsEngine", () => {
  it("falls through to Web-Speech-shaped fallback when a native backend fails", async () => {
    const health = new SilentTts().getHealth();
    const speakFallback = vi.fn(async () => {});
    const engine = (id: string, speak: TtsEngine["speak"]): TtsEngine => ({
      descriptor: { ...health.descriptor, id, label: id },
      isAvailable: () => true,
      getHealth: () => ({
        ...health,
        descriptor: { ...health.descriptor, id, label: id },
        status: "ready",
      }),
      speak,
      cancel: vi.fn(),
      isSpeaking: () => false,
    });
    const native = engine("native", async () => {
      throw new Error("device disappeared");
    });
    const web = engine("web", speakFallback);

    await new FallbackTtsEngine([native, web]).speak("Still say this");
    expect(speakFallback).toHaveBeenCalledWith("Still say this", undefined);
  });
});

describe("takeStreamingSpeechChunks", () => {
  it("holds an incomplete sentence, then releases it at its boundary", () => {
    expect(takeStreamingSpeechChunks("Marta is still thinking")).toEqual({
      chunks: [],
      remainder: "Marta is still thinking",
    });
    expect(
      takeStreamingSpeechChunks("Marta is still thinking. Here is the result"),
    ).toEqual({
      chunks: ["Marta is still thinking."],
      remainder: " Here is the result",
    });
  });

  it("flushes the remaining clause at the end of the stream", () => {
    expect(
      takeStreamingSpeechChunks("And one final thing", { final: true }),
    ).toEqual({ chunks: ["And one final thing"], remainder: "" });
  });
});
