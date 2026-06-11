import { describe, expect, it } from "vitest";
import {
  detectAspectRatio,
  looksLikeStoryboardScript,
} from "./storyboard_script";

// A trimmed version of the kind of authored script Orion routes to a storyboard.
const BABY_SHARK_SCRIPT = `Style: Bright 2D cartoon animation, cheerful colors.

Scene 1: Coral Reef Intro (0:00 - 0:08)
A sunny underwater coral reef with fish swimming.

Scene 2: Baby Shark Appears (0:08 - 0:24)
A cute, small yellow cartoon baby shark swims in happily.

Scene 3: The Family (0:24 - 0:40)
Mama and papa shark join the baby shark.`;

describe("looksLikeStoryboardScript", () => {
  it("matches an authored multi-scene script", () => {
    expect(looksLikeStoryboardScript(BABY_SHARK_SCRIPT)).toBe(true);
  });

  it("matches a Style: line plus scene cues across several lines", () => {
    const script = `Style: cinematic, moody lighting
First we open on a city street at night.
The camera follows a lone figure walking.
A neon sign flickers in the storyboard sequence.`;
    expect(looksLikeStoryboardScript(script)).toBe(true);
  });

  it("does NOT match an ordinary one-line media prompt", () => {
    expect(looksLikeStoryboardScript("make a cute shark video")).toBe(false);
    expect(
      looksLikeStoryboardScript(
        "Generate a cinematic hero image of a mountain sunrise",
      ),
    ).toBe(false);
  });

  it("does NOT match a single scene mention without structure", () => {
    expect(looksLikeStoryboardScript("a video of one scene with a shark")).toBe(
      false,
    );
  });

  it("ignores very short input", () => {
    expect(looksLikeStoryboardScript("Scene 1: hi")).toBe(false);
  });

  it("matches numbered scenes written with parentheses or dashes", () => {
    const script = `Scene 1) A wide establishing shot of mountains at dawn.
Scene 2) Close on a hiker cresting the ridge as the sun rises.`;
    expect(looksLikeStoryboardScript(script)).toBe(true);
  });
});

describe("detectAspectRatio", () => {
  it("reads explicit ratios in any common spelling", () => {
    expect(detectAspectRatio("render this in 9:16 please")).toBe("9:16");
    expect(detectAspectRatio("a 16x9 cinematic piece")).toBe("16:9");
    expect(detectAspectRatio("output at 4:3")).toBe("4:3");
  });

  it("maps orientation/platform words to ratios", () => {
    expect(detectAspectRatio("make it vertical for shorts")).toBe("9:16");
    expect(detectAspectRatio("a portrait reel for TikTok")).toBe("9:16");
    expect(detectAspectRatio("widescreen landscape film")).toBe("16:9");
    expect(detectAspectRatio("a square loop")).toBe("1:1");
  });

  it("explicit ratio wins over orientation words", () => {
    expect(detectAspectRatio("a vertical feel but render 16:9")).toBe("16:9");
  });

  it("returns null when the script doesn't say", () => {
    expect(detectAspectRatio(BABY_SHARK_SCRIPT)).toBeNull();
    expect(detectAspectRatio("a calm ocean video")).toBeNull();
  });
});
