import { describe, it, expect } from "vitest";
import {
  AUTO_TIER_ID,
  ORION_MEDIA_CATALOG,
  defaultSelection,
  resolveSelection,
  resolveDownloadPlan,
  findOption,
} from "./orion_media_catalog";

describe("orion_media_catalog", () => {
  it("defaultSelection picks the first option per modality (Auto where offered)", () => {
    const d = defaultSelection();
    expect(d.image).toBe(AUTO_TIER_ID);
    expect(d.video).toBe(AUTO_TIER_ID);
    expect(d.music).toBe(AUTO_TIER_ID);
    expect(d.speech).toBe("speecht5-cpu");
    expect(d.threed).toBe("triposr-6gb");
  });

  it("offers multiple options for image/video/speech", () => {
    expect(ORION_MEDIA_CATALOG.image.length).toBeGreaterThan(1);
    expect(ORION_MEDIA_CATALOG.video.length).toBeGreaterThan(1);
    expect(ORION_MEDIA_CATALOG.speech.length).toBeGreaterThan(1);
  });

  it("video offers the production tiers plus the CPU fallback", () => {
    const ids = ORION_MEDIA_CATALOG.video.map((o) => o.tierId);
    expect(ids).toEqual([
      AUTO_TIER_ID,
      "wan-2.2-i2v",
      "ltx-2-av-small",
      "ltx-video",
      "wan-2.2-5b",
      "animatediff-sd15",
      "animatediff-sd15-small",
      "text-to-video-cpu",
    ]);
  });

  it("resolveSelection merges valid saved ids over defaults", () => {
    const s = resolveSelection({ image: "sd-turbo", video: "ltx-video" });
    expect(s.image).toBe("sd-turbo");
    expect(s.video).toBe("ltx-video");
    expect(s.music).toBe(defaultSelection().music);
  });

  it("resolveSelection ignores stale/unknown saved ids (falls back to default)", () => {
    // e.g. ids from a previous catalog version (wan/cogvideox were removed)
    const s = resolveSelection({
      threed: "triposr",
      music: "ace-step-1.5-xl-turbo",
      video: "wan-2.1-14b",
    });
    expect(s.threed).toBe("triposr-6gb");
    expect(s.music).toBe(AUTO_TIER_ID);
    expect(s.video).toBe(AUTO_TIER_ID);
  });

  it("findOption returns the matching option", () => {
    expect(findOption("image", "sd-turbo")?.downloadId).toBe("image-sd-turbo");
    expect(findOption("image", "nope")).toBeUndefined();
  });

  it("video (ltx-video) has no pre-download id (downloads on demand)", () => {
    expect(findOption("video", "ltx-video")?.downloadId).toBeUndefined();
  });

  it("resolveDownloadPlan with Auto defaults pre-downloads nothing weight-specific", () => {
    // Auto selections have no download id — the hardware-matched weights are
    // fetched by the setup flow / on first use instead.
    const all = resolveDownloadPlan(defaultSelection(), new Set());
    expect(all.models).toContain("audio"); // speech (SpeechT5) is concrete
    expect(all.models).not.toContain("video");
    // TripoSR (3d) is a runtime install; music defaults to Auto.
    expect(all.runtimes).toEqual(["3d"]);
  });

  it("resolveDownloadPlan lists only missing downloadable weights", () => {
    const explicit = {
      ...defaultSelection(),
      image: "z-image-turbo",
      music: "ace-step-xl-turbo-12gb",
    };
    const all = resolveDownloadPlan(explicit, new Set());
    expect(all.models).toContain("image-z-image-turbo"); // image
    expect(all.models).toContain("audio"); // speech (SpeechT5)
    // ACE-Step (music) + TripoSR (3d) are runtime installs, not weight downloads.
    expect(all.runtimes).toEqual(["music", "3d"]);

    // Already-downloaded ones are skipped.
    const partial = resolveDownloadPlan(
      explicit,
      new Set(["image-z-image-turbo"]),
    );
    expect(partial.models).not.toContain("image-z-image-turbo");
    expect(partial.models).toContain("audio");
  });

  it("resolveDownloadPlan can prepare only the modality required by the plan", () => {
    const explicit = {
      ...defaultSelection(),
      image: "z-image-turbo",
    };

    const imageOnly = resolveDownloadPlan(explicit, new Set(), ["image"]);
    expect(imageOnly.models).toEqual(["image-z-image-turbo"]);
    expect(imageOnly.runtimes).toEqual([]);

    const speechOnly = resolveDownloadPlan(explicit, new Set(), ["speech"]);
    expect(speechOnly.models).toEqual(["audio"]);
    expect(speechOnly.runtimes).toEqual([]);
  });
});
