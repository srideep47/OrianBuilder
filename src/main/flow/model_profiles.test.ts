import { describe, it, expect } from "vitest";
import {
  selectProfileForVram,
  getProfileById,
  modelConfigForAsset,
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
  it("maps music → ACE-Step", () => {
    expect(modelConfigForAsset(p, "music").modelId).toBe(
      "ace-step-1.5-xl-turbo",
    );
  });
  it("maps 3d → TripoSR (mesh), with a separate image ref model", () => {
    expect(modelConfigForAsset(p, "3d").modelId).toBe("triposr");
    expect(p.threeDRef.modelId).toBe("z-image-turbo");
  });
});

describe("profile invariants", () => {
  it("disables TTS and transcribe in the build flow", () => {
    expect(HARDWARE_MODEL_PROFILES[0].disabledModalities).toEqual([
      "tts",
      "transcribe",
    ]);
  });
});
