import { describe, expect, it } from "vitest";
import {
  VIDEO_TIERS,
  pickBestVideoTier,
  tierFitsHardware,
} from "./media_tiers";

// The two LTX-2.3 AV tiers mirror mediaai-backend/.../models/video.py: the
// full tier is floor-gated (≥12 GB VRAM & ≥24 GB RAM), the distilled tier is
// gated on a VRAM+RAM combination (any_of). These tests pin the TS half of
// that contract to the devices OrianBuilder targets.

describe("pickBestVideoTier (RAM-aware)", () => {
  it("picks the full LTX-2.3 AV tier on a 16 GB GPU with 64 GB RAM (RTX 4080S class)", () => {
    expect(pickBestVideoTier(16384, undefined, 65536).id).toBe("ltx-2-av");
  });

  it("picks the distilled LTX-2.3 tier on a 6 GB GPU with 16 GB RAM (RTX 3060 class)", () => {
    expect(pickBestVideoTier(6144, undefined, 16384).id).toBe("ltx-2-av-small");
  });

  it("picks the distilled LTX-2.3 tier on a 4 GB GPU with 40 GB RAM (GTX 1650 Ti class)", () => {
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
    expect(pickBestVideoTier(16384).id).toBe("ltx-2-av");
    expect(pickBestVideoTier(6144).id).toBe("ltx-2-av-small");
  });
});

describe("tierFitsHardware", () => {
  const ltx2Full = VIDEO_TIERS.find((t) => t.id === "ltx-2-av")!;
  const ltx2Small = VIDEO_TIERS.find((t) => t.id === "ltx-2-av-small")!;

  it("full tier: VRAM and RAM floors must BOTH be met", () => {
    expect(tierFitsHardware(ltx2Full, 16384, 65536)).toBe(true);
    expect(tierFitsHardware(ltx2Full, 16384, 16384)).toBe(false);
    expect(tierFitsHardware(ltx2Full, 8192, 65536)).toBe(false);
  });

  it("distilled tier any_of: either VRAM/RAM combination qualifies", () => {
    expect(tierFitsHardware(ltx2Small, 6144, 10240)).toBe(true);
    expect(tierFitsHardware(ltx2Small, 4096, 30720)).toBe(true);
    expect(tierFitsHardware(ltx2Small, 4096, 10240)).toBe(false);
    expect(tierFitsHardware(ltx2Small, 2048, 65536)).toBe(false);
  });

  it("only the two AV tiers are flagged as generating audio", () => {
    expect(ltx2Full.generatesAudio).toBe(true);
    expect(ltx2Small.generatesAudio).toBe(true);
    for (const tier of VIDEO_TIERS) {
      if (tier.id !== "ltx-2-av" && tier.id !== "ltx-2-av-small") {
        expect(tier.generatesAudio ?? false).toBe(false);
      }
    }
  });
});
