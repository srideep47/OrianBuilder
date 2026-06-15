import { describe, expect, it } from "vitest";
import {
  VIDEO_TIERS,
  pickBestVideoTier,
  tierFitsHardware,
} from "./media_tiers";

// The LTX-2.3 AV tier mirrors mediaai-backend/.../models/video.py: it is gated
// on a VRAM+RAM combination (any_of) because its GGUF transformer + Gemma-3 TE
// stream through group offloading. These tests pin the TS half of that contract
// to the devices OrianBuilder targets. (The full bf16 "ltx-2-av" dev tier was
// removed — bnb-4bit leaves a meta tensor during offload on current diffusers.)

describe("pickBestVideoTier (RAM-aware)", () => {
  it("picks the LTX-2.3 AV tier on a 16 GB GPU with 64 GB RAM (RTX 4080S class)", () => {
    expect(pickBestVideoTier(16384, undefined, 65536).id).toBe(
      "ltx-2-av-small",
    );
  });

  it("picks the LTX-2.3 AV tier on a 6 GB GPU with 16 GB RAM (RTX 3060 class)", () => {
    expect(pickBestVideoTier(6144, undefined, 16384).id).toBe("ltx-2-av-small");
  });

  it("picks the LTX-2.3 AV tier on a 4 GB GPU with 40 GB RAM (GTX 1650 Ti class)", () => {
    expect(pickBestVideoTier(4096, undefined, 40960).id).toBe("ltx-2-av-small");
  });

  it("skips LTX-2.3 on a 4 GB GPU with only 16 GB RAM (offload won't fit)", () => {
    expect(pickBestVideoTier(4096, undefined, 16384).id).toBe(
      "animatediff-sd15-small",
    );
  });

  it("skips LTX-2.3 on a 6 GB GPU with under 10 GB RAM", () => {
    expect(pickBestVideoTier(6144, undefined, 8192).id).toBe(
      "animatediff-sd15",
    );
  });

  it("falls back to the CPU tier when nothing fits", () => {
    expect(pickBestVideoTier(0, undefined, 4096).id).toBe("text-to-video-cpu");
  });

  it("treats unknown RAM as passing (the backend re-validates with real RAM)", () => {
    expect(pickBestVideoTier(16384).id).toBe("ltx-2-av-small");
    expect(pickBestVideoTier(6144).id).toBe("ltx-2-av-small");
  });

  it("picks Wan 2.2 14B i2v on a 16 GB GPU when a keyframe image is present", () => {
    expect(pickBestVideoTier(16384, undefined, 65536, true).id).toBe(
      "wan-2.2-i2v",
    );
  });

  it("never picks the i2v-only Wan tier without an image (t2v request)", () => {
    expect(pickBestVideoTier(16384, undefined, 65536, false).id).toBe(
      "ltx-2-av-small",
    );
    for (const t of [pickBestVideoTier(24576, undefined, 131072)]) {
      expect(t.requiresImage ?? false).toBe(false);
    }
  });

  it("Wan 2.2 5B fits the 6 GB VRAM / 16 GB RAM hardware floor", () => {
    const wan5b = VIDEO_TIERS.find((t) => t.id === "wan-2.2-5b")!;
    expect(tierFitsHardware(wan5b, 6144, 16384)).toBe(true);
    expect(tierFitsHardware(wan5b, 4096, 16384)).toBe(false);
  });
});

describe("tierFitsHardware", () => {
  const ltx2Small = VIDEO_TIERS.find((t) => t.id === "ltx-2-av-small")!;

  it("distilled tier any_of: either VRAM/RAM combination qualifies", () => {
    expect(tierFitsHardware(ltx2Small, 6144, 10240)).toBe(true);
    expect(tierFitsHardware(ltx2Small, 4096, 30720)).toBe(true);
    expect(tierFitsHardware(ltx2Small, 4096, 10240)).toBe(false);
    expect(tierFitsHardware(ltx2Small, 2048, 65536)).toBe(false);
  });

  it("only the LTX-2.3 AV tier is flagged as generating audio", () => {
    expect(ltx2Small.generatesAudio).toBe(true);
    for (const tier of VIDEO_TIERS) {
      if (tier.id !== "ltx-2-av-small") {
        expect(tier.generatesAudio ?? false).toBe(false);
      }
    }
  });
});
