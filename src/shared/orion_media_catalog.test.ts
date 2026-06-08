import { describe, it, expect } from "vitest";
import {
  ORION_MEDIA_CATALOG,
  defaultSelection,
  resolveSelection,
  resolveDownloadPlan,
  findOption,
} from "./orion_media_catalog";

describe("orion_media_catalog", () => {
  it("defaultSelection picks the first option per modality", () => {
    const d = defaultSelection();
    expect(d.image).toBe("z-image-turbo");
    expect(d.video).toBe("ltx-video");
    expect(d.music).toBe("ace-step-xl-turbo-12gb");
    expect(d.speech).toBe("speecht5-cpu");
    expect(d.threed).toBe("triposr-6gb");
  });

  it("offers multiple options for image/video/speech", () => {
    expect(ORION_MEDIA_CATALOG.image.length).toBeGreaterThan(1);
    expect(ORION_MEDIA_CATALOG.video.length).toBeGreaterThan(1);
    expect(ORION_MEDIA_CATALOG.speech.length).toBeGreaterThan(1);
  });

  it("resolveSelection merges valid saved ids over defaults", () => {
    const s = resolveSelection({ image: "sd-turbo", video: "wan-2.1-14b" });
    expect(s.image).toBe("sd-turbo");
    expect(s.video).toBe("wan-2.1-14b");
    expect(s.music).toBe(defaultSelection().music);
  });

  it("resolveSelection ignores stale/unknown saved ids (falls back to default)", () => {
    // e.g. an old id from a previous catalog version
    const s = resolveSelection({
      threed: "triposr",
      music: "ace-step-1.5-xl-turbo",
    });
    expect(s.threed).toBe("triposr-6gb");
    expect(s.music).toBe("ace-step-xl-turbo-12gb");
  });

  it("findOption returns the matching option", () => {
    expect(findOption("image", "sd-turbo")?.downloadId).toBe("image-sd-turbo");
    expect(findOption("image", "nope")).toBeUndefined();
  });

  it("video (ltx-video) has no pre-download id (downloads on demand)", () => {
    expect(findOption("video", "ltx-video")?.downloadId).toBeUndefined();
  });

  it("resolveDownloadPlan lists only missing downloadable weights", () => {
    // Nothing downloaded yet → only models with a matching download id queue.
    const all = resolveDownloadPlan(defaultSelection(), new Set());
    expect(all.models).toContain("image-z-image-turbo"); // image
    expect(all.models).toContain("audio"); // speech (SpeechT5)
    // LTX video has no matching download id → never queued for pre-download.
    expect(all.models).not.toContain("video");
    // ACE-Step (music) + TripoSR (3d) are runtime installs, not weight downloads.
    expect(all.runtimes).toEqual(["music", "3d"]);

    // Already-downloaded ones are skipped.
    const partial = resolveDownloadPlan(
      defaultSelection(),
      new Set(["image-z-image-turbo"]),
    );
    expect(partial.models).not.toContain("image-z-image-turbo");
    expect(partial.models).toContain("audio");
  });
});
