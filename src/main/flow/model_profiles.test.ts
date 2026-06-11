import { describe, it, expect } from "vitest";
import {
  selectProfileForVram,
  getProfileById,
  modelConfigForAsset,
  applySelectionToProfile,
  HARDWARE_MODEL_PROFILES,
} from "./model_profiles";

describe("selectProfileForVram", () => {
  it("selects the 4080S (top) profile for 16 GB", () => {
    expect(selectProfileForVram(16000).id).toBe("rtx-4080s-16gb");
  });

  it("selects the 3060 (mid) profile for 6 GB", () => {
    expect(selectProfileForVram(6144).id).toBe("rtx-3060-6gb");
  });

  it("selects the 1650 Ti (small) profile for 4 GB", () => {
    expect(selectProfileForVram(4096).id).toBe("gtx-1650ti-4gb");
  });

  it("selects the small profile for no GPU at all", () => {
    expect(selectProfileForVram(0).id).toBe("gtx-1650ti-4gb");
  });
});

describe("getProfileById", () => {
  it("finds a known profile", () => {
    expect(getProfileById("rtx-4080s-16gb")?.label).toContain("4080");
  });
  it("returns undefined for unknown", () => {
    expect(getProfileById("nope")).toBeUndefined();
  });
});

describe("modelConfigForAsset", () => {
  const top = HARDWARE_MODEL_PROFILES[0];
  it("maps image → Z Image Turbo on the top profile", () => {
    expect(modelConfigForAsset(top, "image").modelId).toBe("z-image-turbo");
  });
  it("maps video → Auto on the top profile (RAM-aware tier selection)", () => {
    expect(modelConfigForAsset(top, "video").modelId).toBe("auto");
  });
  it("maps music → ACE-Step (backend tier id)", () => {
    expect(modelConfigForAsset(top, "music").modelId).toBe(
      "ace-step-xl-turbo-12gb",
    );
  });
  it("maps 3d → TripoSR (mesh), with a separate image ref model", () => {
    expect(modelConfigForAsset(top, "3d").modelId).toBe("triposr-6gb");
    expect(top.threeDRef.modelId).toBe("z-image-turbo");
  });
});

describe("per-device video tiers", () => {
  it("every profile defers the video tier to RAM-aware auto-selection", () => {
    // Video tier choice is VRAM+RAM gated (LTX-2 trades VRAM for system RAM
    // via offload), which a VRAM-only profile cannot express — so profiles
    // never force a video tier; the dispatcher/backend select it live.
    expect(selectProfileForVram(16384).video.modelId).toBe("auto");
    expect(selectProfileForVram(6144).video.modelId).toBe("auto");
    expect(selectProfileForVram(4096).video.modelId).toBe("auto");
  });

  it("every stage's footprint fits the profile's VRAM floor", () => {
    // A stage's single-slot footprint must fit the *floor* of the window the
    // profile claims to serve. The floor-less small profile is exempt — its
    // backend tiers degrade further (sequential offload → CPU) on their own.
    for (const profile of HARDWARE_MODEL_PROFILES) {
      if (profile.minVramMb === 0) continue;
      expect(profile.video.vramMb).toBeLessThanOrEqual(profile.minVramMb);
      expect(profile.image.vramMb).toBeLessThanOrEqual(profile.minVramMb);
    }
  });
});

describe("profile invariants", () => {
  it("disables transcribe but supports speech (TTS) in the build flow", () => {
    for (const profile of HARDWARE_MODEL_PROFILES) {
      expect(profile.disabledModalities).toEqual(["transcribe"]);
    }
  });

  it("provides a speech stage config", () => {
    for (const profile of HARDWARE_MODEL_PROFILES) {
      expect(profile.speech.modelId).toBeTruthy();
    }
  });

  it("profiles tile the VRAM range without gaps", () => {
    const sorted = [...HARDWARE_MODEL_PROFILES].sort(
      (a, b) => a.minVramMb - b.minVramMb,
    );
    expect(sorted[0].minVramMb).toBe(0);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i - 1].maxVramMb).toBe(sorted[i].minVramMb);
    }
    expect(sorted[sorted.length - 1].maxVramMb).toBeUndefined();
  });
});

describe("applySelectionToProfile", () => {
  const base = HARDWARE_MODEL_PROFILES[0];

  it("overrides each stage's modelId with the user's selection", () => {
    const p = applySelectionToProfile(base, {
      image: "sd-turbo",
      video: "animatediff-sd15",
      music: "my-music",
      speech: "kokoro-82m",
      threed: "my-3d",
    });
    expect(p.image.modelId).toBe("sd-turbo");
    expect(p.threeDRef.modelId).toBe("sd-turbo"); // 3D ref uses the image model
    expect(p.video.modelId).toBe("animatediff-sd15");
    expect(p.music.modelId).toBe("my-music");
    expect(p.speech.modelId).toBe("kokoro-82m");
    expect(p.threeD.modelId).toBe("my-3d");
  });

  it("keeps profile defaults for unset selections and does not mutate base", () => {
    const p = applySelectionToProfile(base, { image: "sd-turbo" });
    expect(p.video.modelId).toBe(base.video.modelId);
    expect(base.image.modelId).not.toBe("sd-turbo");
  });

  it('keeps the hardware-matched default for "auto" selections', () => {
    const p = applySelectionToProfile(base, {
      image: "auto",
      video: "auto",
      music: "auto",
      speech: "auto",
      threed: "auto",
    });
    expect(p.image.modelId).toBe(base.image.modelId);
    expect(p.video.modelId).toBe(base.video.modelId);
    expect(p.music.modelId).toBe(base.music.modelId);
    expect(p.speech.modelId).toBe(base.speech.modelId);
    expect(p.threeD.modelId).toBe(base.threeD.modelId);
  });
});
