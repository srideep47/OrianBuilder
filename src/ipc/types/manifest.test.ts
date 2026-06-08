import { describe, it, expect } from "vitest";
import {
  AssetManifestSchema,
  AssetSpecSchema,
  validateManifest,
  groupAssetsByModality,
  ASSET_TYPE_ORDER,
  type AssetManifest,
} from "./manifest";

function manifest(assets: unknown[]): AssetManifest {
  return AssetManifestSchema.parse({ buildId: "build-1", assets });
}

describe("AssetSpec defaults", () => {
  it("defaults settings to {} and status to pending", () => {
    const spec = AssetSpecSchema.parse({
      id: "hero",
      type: "image",
      targetFilename: "assets/hero.png",
      prompt: "a hero banner",
    });
    expect(spec.settings).toEqual({});
    expect(spec.status).toBe("pending");
  });
});

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    const m = manifest([
      { id: "hero", type: "image", targetFilename: "a/hero.png", prompt: "x" },
      {
        id: "mascot-ref",
        type: "image",
        targetFilename: "a/mascot-ref.png",
        prompt: "y",
      },
      {
        id: "mascot",
        type: "3d",
        targetFilename: "a/mascot.glb",
        prompt: "z",
        refAssetId: "mascot-ref",
      },
    ]);
    expect(validateManifest(m)).toEqual({ ok: true, errors: [] });
  });

  it("flags duplicate ids", () => {
    const m = manifest([
      { id: "a", type: "image", targetFilename: "1.png", prompt: "x" },
      { id: "a", type: "image", targetFilename: "2.png", prompt: "y" },
    ]);
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("duplicate asset id"))).toBe(true);
  });

  it("flags duplicate targetFilenames", () => {
    const m = manifest([
      { id: "a", type: "image", targetFilename: "same.png", prompt: "x" },
      { id: "b", type: "image", targetFilename: "same.png", prompt: "y" },
    ]);
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("duplicate targetFilename"))).toBe(
      true,
    );
  });

  it("flags refs to unknown assets", () => {
    const m = manifest([
      {
        id: "mascot",
        type: "3d",
        targetFilename: "m.glb",
        prompt: "z",
        refAssetId: "nope",
      },
    ]);
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("unknown asset"))).toBe(true);
  });

  it("flags refs to non-image assets", () => {
    const m = manifest([
      { id: "clip", type: "video", targetFilename: "c.mp4", prompt: "v" },
      {
        id: "mascot",
        type: "3d",
        targetFilename: "m.glb",
        prompt: "z",
        refAssetId: "clip",
      },
    ]);
    const res = validateManifest(m);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("must be images"))).toBe(true);
  });
});

describe("groupAssetsByModality", () => {
  it("returns groups in fixed order, skipping empties, preserving inner order", () => {
    const m = manifest([
      { id: "song", type: "music", targetFilename: "s.wav", prompt: "m" },
      { id: "img2", type: "image", targetFilename: "2.png", prompt: "x" },
      { id: "img1", type: "image", targetFilename: "1.png", prompt: "y" },
    ]);
    const groups = groupAssetsByModality(m);
    expect(groups.map((g) => g.type)).toEqual(["image", "music"]);
    expect(groups[0].assets.map((a) => a.id)).toEqual(["img2", "img1"]);
  });

  it("orders image before 3d before speech before video before music", () => {
    expect([...ASSET_TYPE_ORDER]).toEqual([
      "image",
      "3d",
      "speech",
      "video",
      "music",
    ]);
  });
});
