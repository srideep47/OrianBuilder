import { describe, expect, it } from "vitest";
import { planModelDownloads } from "./model_plan";

describe("planModelDownloads", () => {
  it("downloads the selected image + speech weights plus a base video model", () => {
    const plan = planModelDownloads(
      { image: "z-image-turbo", speech: "speecht5-cpu" },
      [],
    );
    const ids = plan.map((p) => p.id);
    expect(ids).toContain("image-z-image-turbo"); // selected image tier
    expect(ids).toContain("audio"); // SpeechT5 download id
    expect(ids).toContain("video"); // base video for storyboards
  });

  it("skips models already on disk", () => {
    const plan = planModelDownloads({ image: "sd-turbo" }, [
      "image-sd-turbo",
      "video",
    ]);
    expect(plan.map((p) => p.id)).not.toContain("image-sd-turbo");
    expect(plan.map((p) => p.id)).not.toContain("video");
  });

  it("returns labelled, de-duplicated entries", () => {
    const plan = planModelDownloads(undefined, []);
    const ids = plan.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of plan) {
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("returns an empty plan once everything the selection needs is present", () => {
    // Default selection: image=z-image-turbo (download id image-z-image-turbo),
    // speech=speecht5-cpu (download id audio); video/music have no pre-download
    // id so only the generic 'video' base model is added.
    const plan = planModelDownloads(undefined, [
      "image-z-image-turbo",
      "audio",
      "video",
    ]);
    expect(plan).toHaveLength(0);
  });
});
