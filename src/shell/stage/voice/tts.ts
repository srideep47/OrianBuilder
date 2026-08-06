/**
 * Marta's voice.
 *
 * **Why not the media backend's TTS.** The app already has Piper, Kokoro,
 * XTTS and F5 as audio tiers — but they run through the media dispatcher, which
 * runs through the ModelGate's *exclusive* slot. Routing her speech through it
 * would evict the image model every time she opened her mouth, which is exactly
 * the thing the companion tier exists to prevent. Her voice has to live outside
 * the gate.
 *
 * **Why Web Speech first.** It needs no download, no model, no process, and its
 * `cancel()` is synchronous — which matters more here than voice quality does,
 * because barge-in is only convincing if she stops *immediately*. A 200ms tail
 * after the user starts talking reads as her ignoring them.
 *
 * The interface is the point. Piper (a CPU process beside llama-server) or
 * Kokoro (ONNX in the renderer) drop in behind `TtsEngine` without the turn
 * loop or the state machine changing.
 */

import type { VoiceBackendDescriptor, VoiceBackendHealth } from "./runtime";

export interface TtsVoicePreferences {
  language?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  /** Case-insensitive name fragments, in preference order. */
  preferredVoiceNames?: string[];
}

export interface TtsEngine {
  readonly descriptor: VoiceBackendDescriptor;
  /** True when this engine can actually speak on this machine. */
  isAvailable(): boolean;
  getHealth(): VoiceBackendHealth;
  /**
   * Speak one chunk. Resolves when it finishes, or immediately if cancelled.
   * Must never reject — a failed utterance ends the turn, it does not break it.
   */
  speak(text: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** Stop immediately, dropping anything queued. */
  cancel(): void;
  /** True while audio is playing. Used to duck the VAD. */
  isSpeaking(): boolean;
}

/** Pick the most conversational English voice exposed by the operating system. */
export function selectPreferredVoice(
  voices: readonly SpeechSynthesisVoice[],
  preferences: TtsVoicePreferences = {},
): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const preferredLanguage = preferences.language?.toLowerCase();
  const preferredNames = preferences.preferredVoiceNames?.map((name) =>
    name.toLowerCase(),
  );
  const scored = voices.map((voice, index) => {
    const name = voice.name.toLowerCase();
    const lang = voice.lang.toLowerCase();
    let score = 0;
    if (preferredLanguage && lang.startsWith(preferredLanguage)) score += 140;
    const preferredNameIndex = preferredNames?.findIndex((candidate) =>
      name.includes(candidate),
    );
    if (preferredNameIndex !== undefined && preferredNameIndex >= 0) {
      score += 180 - preferredNameIndex * 10;
    }
    if (lang.startsWith("en-in")) score += 28;
    else if (lang.startsWith("en-gb")) score += 24;
    else if (lang.startsWith("en-us")) score += 22;
    else if (lang.startsWith("en")) score += 15;
    else score -= 100;
    if (/natural|neural|online/.test(name)) score += 100;
    if (/aria|ava|jenny|sonia|samantha|zira|serena/.test(name)) score += 35;
    if (/microsoft|google|apple/.test(name)) score += 12;
    if (voice.localService) score += 3;
    if (voice.default) score += 2;
    return { voice, score, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.voice ?? null;
}

/**
 * Split into chunks that can be spoken as they arrive.
 *
 * Sentence-ish, with a hard cap: TTS latency scales with chunk length, so a
 * 400-word paragraph would take seconds before the first sound. Splitting on
 * punctuation keeps prosody natural; the cap catches the model writing a
 * sentence without any.
 */
export function chunkForSpeech(text: string, maxChars = 220): string[] {
  const cleaned = text
    // Code blocks are unspeakable. Saying "here is the code" is more useful
    // than reading braces aloud, and the transcript still shows the real thing.
    .replace(/```[\s\S]*?```/g, " (code shown on screen) ")
    .replace(/`([^`]+)`/g, "$1")
    // Markdown emphasis and list bullets are punctuation for the eye only.
    .replace(/^[\s]*[-*+]\s+/gm, "")
    .replace(/[*_#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return [];

  const sentences = cleaned.match(/[^.!?]+[.!?]*/g) ?? [cleaned];
  const chunks: string[] = [];
  let current = "";

  /**
   * Only hard-split a sentence that is *substantially* over the cap.
   *
   * A sentence is a natural unit of speech, and breaking one mid-clause is
   * always more audible than an utterance that runs slightly long. The cap
   * exists to bound time-to-first-sound, not to be exact — so a sentence a few
   * characters over goes out whole, and only a genuinely runaway one is cut.
   */
  const hardSplitAt = maxChars * 2;

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;

    if (sentence.length > hardSplitAt) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      // Break on the last space before the cap so words stay whole.
      let rest = sentence;
      while (rest.length > maxChars) {
        const cut = rest.lastIndexOf(" ", maxChars);
        const at = cut > maxChars * 0.5 ? cut : maxChars;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      if (rest) current = rest;
      continue;
    }

    if (current.length + sentence.length + 1 > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Peel complete, natural speech units from an incremental model response.
 *
 * Sentence boundaries give TTS enough context to sound natural, without
 * waiting for a whole model response. A punctuation-free response is still
 * released at the cap so it cannot hold the voice bus indefinitely.
 */
export function takeStreamingSpeechChunks(
  buffer: string,
  options: { final?: boolean; maxChars?: number } = {},
): { chunks: string[]; remainder: string } {
  const maxChars = options.maxChars ?? 220;
  let cut = 0;

  if (options.final) {
    cut = buffer.length;
  } else {
    for (const match of buffer.matchAll(/[.!?]+(?=\s|$)/g)) {
      cut = (match.index ?? 0) + match[0].length;
    }
    if (cut === 0 && buffer.length >= maxChars) {
      const space = buffer.lastIndexOf(" ", maxChars);
      cut = space > maxChars * 0.5 ? space : maxChars;
    }
  }

  if (cut === 0) return { chunks: [], remainder: buffer };
  return {
    chunks: chunkForSpeech(buffer.slice(0, cut), maxChars),
    remainder: buffer.slice(cut),
  };
}

/** The OS voice, via `speechSynthesis`. */
export class WebSpeechTts implements TtsEngine {
  readonly descriptor: VoiceBackendDescriptor = {
    id: "web-speech",
    label: "System natural voice",
    kind: "tts",
    execution: "browser",
  };
  private speaking = false;
  private activeFinishes = new Set<() => void>();

  constructor(
    private readonly preferences: TtsVoicePreferences = {},
    private readonly now: () => number = Date.now,
  ) {}

  isAvailable(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof window.speechSynthesis !== "undefined" &&
      typeof SpeechSynthesisUtterance !== "undefined"
    );
  }

  getHealth(): VoiceBackendHealth {
    const available = this.isAvailable();
    const voices = available ? window.speechSynthesis.getVoices() : [];
    return {
      descriptor: this.descriptor,
      status: !available
        ? "unavailable"
        : voices.length > 0
          ? "ready"
          : "degraded",
      detail: !available
        ? "This runtime does not expose Web Speech synthesis."
        : voices.length === 0
          ? "Speech synthesis is present, but the operating system has not exposed a voice yet."
          : undefined,
      supportsStreaming: true,
      supportsCancellation: true,
      checkedAt: this.now(),
    };
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  speak(text: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (!this.isAvailable() || !text.trim()) return Promise.resolve();
    if (options.signal?.aborted) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = selectPreferredVoice(
        window.speechSynthesis.getVoices(),
        this.preferences,
      );
      if (voice) utterance.voice = voice;
      utterance.lang =
        voice?.lang ||
        this.preferences.language ||
        navigator.language ||
        "en-US";
      // Conversational rather than announcer-like. Neural/natural OS voices
      // preserve their own prosody best near their native speed and pitch.
      utterance.rate = this.preferences.rate ?? 1.02;
      utterance.pitch = this.preferences.pitch ?? 1;
      utterance.volume = this.preferences.volume ?? 1;

      let settled = false;
      let watchdog: number | null = null;
      function onAbort() {
        window.speechSynthesis.cancel();
        finish();
      }
      const finish = () => {
        if (settled) return;
        settled = true;
        if (watchdog !== null) window.clearTimeout(watchdog);
        this.activeFinishes.delete(finish);
        this.speaking = this.activeFinishes.size > 0;
        options.signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      // Chromium occasionally omits `onend` after an audio-device change. A
      // bounded watchdog prevents one lost event from blocking every later
      // announcement. The generous estimate does not cut normal speech short.
      const watchdogMs = Math.min(45_000, Math.max(8_000, text.length * 95));
      watchdog = window.setTimeout(() => {
        window.speechSynthesis.cancel();
        finish();
      }, watchdogMs);

      utterance.onend = finish;
      // Resolve rather than reject: `interrupted` and `canceled` are the normal
      // outcome of barge-in, and treating them as errors would surface a toast
      // every time the user spoke over her.
      utterance.onerror = finish;

      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.activeFinishes.add(finish);
      this.speaking = true;
      try {
        window.speechSynthesis.speak(utterance);
      } catch {
        // A disappearing audio device is a voice degradation, not a rejected
        // Marta turn. The fallback runtime may recover on the next chunk.
        finish();
      }
    });
  }

  cancel(): void {
    if (!this.isAvailable()) return;
    this.speaking = false;
    window.speechSynthesis.cancel();
    for (const finish of this.activeFinishes) finish();
  }
}

/** A no-op engine, so a machine with no speech synthesis still runs the loop. */
export class SilentTts implements TtsEngine {
  readonly descriptor: VoiceBackendDescriptor = {
    id: "silent",
    label: "Text-only fallback",
    kind: "tts",
    execution: "browser",
  };
  isAvailable(): boolean {
    return false;
  }
  getHealth(): VoiceBackendHealth {
    return {
      descriptor: this.descriptor,
      status: "unavailable",
      detail:
        "No speech synthesis backend is available; Marta remains text-capable.",
      supportsStreaming: false,
      supportsCancellation: true,
      checkedAt: Date.now(),
    };
  }
  speak(): Promise<void> {
    return Promise.resolve();
  }
  cancel(): void {}
  isSpeaking(): boolean {
    return false;
  }
}

/** Dynamically chooses the first healthy engine, retaining Web Speech fallback. */
export class FallbackTtsEngine implements TtsEngine {
  constructor(private readonly candidates: readonly TtsEngine[]) {}

  private get active(): TtsEngine {
    for (const candidate of this.candidates) {
      try {
        if (candidate.isAvailable()) return candidate;
      } catch {
        // A broken plugin cannot take down the browser fallback.
      }
    }
    return new SilentTts();
  }

  get descriptor(): VoiceBackendDescriptor {
    return this.active.descriptor;
  }

  isAvailable(): boolean {
    return this.candidates.some((candidate) => {
      try {
        return candidate.isAvailable();
      } catch {
        return false;
      }
    });
  }

  getHealth(): VoiceBackendHealth {
    return this.active.getHealth();
  }

  async speak(text: string, options?: { signal?: AbortSignal }): Promise<void> {
    for (const candidate of this.candidates) {
      try {
        if (!candidate.isAvailable()) continue;
        await candidate.speak(text, options);
        return;
      } catch {
        if (options?.signal?.aborted) return;
        // A pluggable native engine may fail despite reporting available.
        // Continue to Web Speech instead of dropping the spoken reply.
      }
    }
  }

  cancel(): void {
    for (const candidate of this.candidates) {
      try {
        candidate.cancel();
      } catch {
        // Continue cancelling the remaining backends.
      }
    }
  }

  isSpeaking(): boolean {
    return this.candidates.some((candidate) => {
      try {
        return candidate.isSpeaking();
      } catch {
        return false;
      }
    });
  }
}

export interface CreateTtsEngineOptions {
  /** Native/local engines ordered from most to least preferred. */
  candidates?: readonly TtsEngine[];
  webSpeech?: TtsVoicePreferences | false;
}

export function createTtsEngine(
  options: CreateTtsEngineOptions = {},
): TtsEngine {
  const candidates = [...(options.candidates ?? [])];
  if (options.webSpeech !== false) {
    candidates.push(new WebSpeechTts(options.webSpeech ?? {}));
  }
  candidates.push(new SilentTts());
  return new FallbackTtsEngine(candidates);
}
