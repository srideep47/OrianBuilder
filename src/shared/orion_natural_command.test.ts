import { describe, expect, it } from "vitest";
import {
  extractNaturalMediaOptions,
  parseDirectMediaCommand,
} from "./orion_natural_command";

describe("Orion natural command routing", () => {
  it("routes the reported cinematic hero prompt directly to image generation", () => {
    const intent = parseDirectMediaCommand(
      "Generate a cinematic hero image of a mountain sunrise",
      42,
    );

    expect(intent?.appId).toBe(42);
    expect(intent?.steps.map((step) => step.capability)).toEqual([
      "generate_image",
    ]);
    expect(intent?.steps.some((step) => step.capability === "build_app")).toBe(
      false,
    );
  });

  it("deduces explicit controls and image variations from natural language", () => {
    const intent = parseDirectMediaCommand(
      "Please create 3 square high-quality images at 768x768, 30 steps, seed 42, without text or watermarks",
    );

    expect(intent?.steps).toHaveLength(3);
    expect(
      intent?.steps.every((step) => step.capability === "generate_image"),
    ).toBe(true);
    expect(intent?.steps[0].input.options).toMatchObject({
      width: 768,
      height: 768,
      aspect_ratio: "1:1",
      quality: "high",
      steps: 30,
      seed: 42,
      negative_prompt: "text or watermarks",
    });
  });

  it("extracts media duration and guidance without requiring UI controls", () => {
    expect(
      extractNaturalMediaOptions(
        "Make a 12 second landscape video with CFG 7.5 in draft quality",
      ),
    ).toMatchObject({
      duration_s: 12,
      aspect_ratio: "16:9",
      guidance: 7.5,
      quality: "draft",
    });
  });

  it("keeps software and mixed requests on the coding-agent path", () => {
    expect(
      parseDirectMediaCommand("Add a cinematic hero image to the landing page"),
    ).toBeNull();
    expect(
      parseDirectMediaCommand("Create an image gallery component for the app"),
    ).toBeNull();
  });

  it("does not mistake questions or negated commands for generation", () => {
    expect(parseDirectMediaCommand("How do I generate an image?")).toBeNull();
    expect(parseDirectMediaCommand("Do not generate an image")).toBeNull();
  });

  it("plans multi-modality and 3D requests without a coding LLM", () => {
    const media = parseDirectMediaCommand(
      "Generate an image and a short video of a moon base",
    );
    expect(media?.steps.map((step) => step.capability)).toEqual([
      "generate_image",
      "generate_video",
    ]);

    const threeD = parseDirectMediaCommand(
      "Create a 3D model of a low-poly pine tree",
    );
    expect(threeD?.steps.map((step) => step.capability)).toEqual([
      "generate_image",
      "generate_3d_asset",
    ]);
    expect(threeD?.steps[1].dependsOn).toEqual(["image-reference"]);
  });
});
