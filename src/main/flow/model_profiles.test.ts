import { describe, it, expect } from "vitest";
import {
  selectProfileForVram,
  getProfileById,
  modelConfigForAsset,
  applySelectionToProfile,
  HARDWARE_MODEL_PROFILES,
} from "./model_profiles";

describe("selectProfileForVram", () => {
  it("selects the 4080S profile for 16 GB", () => {
    expect(selectProfileForVram(16000).id).toBe("rtx-4080s-16gb");
  });

  it("falls back to the lowest-floor profile below every floor", () => {
    // Only one profile today; a tiny GPU still gets a usable config.
    expect(selectProfileForVram(4000).id).toBe("rtx-4080s-16gb");
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
  const p = HARDWARE_MODEL_PROFILES[0];
  it("maps image → Z Image Turbo", () => {
    expect(modelConfigForAsset(p, "image").modelId).toBe("z-image-turbo");
  });
  it("maps video → LTX", () => {
    expect(modelConfigForAsset(p, "video").modelId).toBe("ltx-video");
  });
  it("maps music → ACE-Step (backend tier id)", () => {
    expect(modelConfigForAsset(p, "music").modelId).toBe(
      "ace-step-xl-turbo-12gb",
    );
  });
  it("maps 3d → TripoSR (mesh), with a separate image ref model", () => {
    expect(modelConfigForAsset(p, "3d").modelId).toBe("triposr-6gb");
    expect(p.threeDRef.modelId).toBe("z-image-turbo");
  });
});

describe("profile invariants", () => {
  it("disables transcribe but supports speech (TTS) in the build flow", () => {
    expect(HARDWARE_MODEL_PROFILES[0].disabledModalities).toEqual([
      "transcribe",
    ]);
  });

  it("provides a speech stage config", () => {
    expect(HARDWARE_MODEL_PROFILES[0].speech.modelId).toBeTruthy();
  });
});

describe("applySelectionToProfile", () => {
  const base = HARDWARE_MODEL_PROFILES[0];

  it("overrides each stage's modelId with the user's selection", () => {
    const p = applySelectionToProfile(base, {
      image: "sd-turbo",
      video: "wan-2.1-14b",
      music: "my-music",
      speech: "kokoro-82m",
      threed: "my-3d",
    });
    expect(p.image.modelId).toBe("sd-turbo");
    expect(p.threeDRef.modelId).toBe("sd-turbo"); // 3D ref uses the image model
    expect(p.video.modelId).toBe("wan-2.1-14b");
    expect(p.music.modelId).toBe("my-music");
    expect(p.speech.modelId).toBe("kokoro-82m");
    expect(p.threeD.modelId).toBe("my-3d");
  });

  it("keeps profile defaults for unset selections and does not mutate base", () => {
    const p = applySelectionToProfile(base, { image: "sd-turbo" });
    expect(p.video.modelId).toBe(base.video.modelId);
    expect(base.image.modelId).not.toBe("sd-turbo");
  });
});
