import { describe, expect, it } from "vitest";
import { createScriptParser, parseScriptDeterministic } from "./script_parser";

const BABY_SHARK_SCRIPT = `Video Style Recommendation
Style: Bright 2D cartoon animation, vibrant underwater colors, cute character designs, Disney-style or Cocomelon-style, smooth and playful movement.
Prompt Script
Scene 1: Intro (0:08 - 0:24)
Prompt: A beautiful, bright underwater coral reef scene with colorful sea plants, friendly small fish swimming around, sunbeams filtering through the clear blue water, bubbles floating up, cheerful and upbeat atmosphere, wide shot.
Scene 2: Baby Shark (0:24 - 0:32)
Prompt: A cute, small yellow cartoon baby shark with big happy eyes swimming into the center of the frame, opening and closing its mouth happily to the rhythm, clapping its fins, cheerful underwater background.
Scene 3: Mommy Shark (0:32 - 0:39)
Prompt: A pretty, bright pink cartoon mommy shark with long eyelashes and a sweet smile swimming gracefully alongside the baby shark, opening and closing her mouth happily, friendly animation.
Scene 4: Daddy Shark (0:39 - 0:46)
Prompt: A strong, friendly dark blue cartoon daddy shark with a broad smile swimming into the scene confidently, flexing his fins playfully, swimming next to mommy and baby shark.
Scene 5: Grandma Shark (0:46 - 0:53)
Prompt: An adorable, bright orange cartoon grandma shark wearing cute round glasses, swimming with a kind, gentle smile, opening her mouth to the rhythm next to the family.
Scene 6: Grandpa Shark (0:53 - 1:00)
Prompt: A funny, light green cartoon grandpa shark with a white mustache and a happy expression, swimming into the frame, completing the shark family lineup.
Scene 7: Let's Go Play (1:00 - 1:08)
Prompt: The entire cartoon shark family (yellow, pink, blue, orange, green) swimming together in a playful, joyful circle, doing a happy dance underwater, lots of bubbles.
Scene 8: Run Away (1:08 - 1:15)
Prompt: A school of tiny, colorful tropical fish suddenly looking surprised with wide eyes, turning around quickly, and swimming away fast as a group to escape, fast-paced comedic animation.
Scene 9: Hungry Sharks (1:15 - 1:21)
Prompt: The shark family looking hungry with comical expressions, rubbing their tummies with their fins, mouths open in a non-scary, cartoonish hungry way.
Scene 10: Feed the Sharks (1:21 - 1:29)
Prompt: Friendly cartoon sharks happily munching on floating sea treats or green seaweed, smiling and chewing contentedly with sparkles around them.
Scene 11: It's the End (1:29 - 1:50)
Prompt: The cartoon shark family lining up together, looking directly at the camera, and waving their fins goodbye to the viewer with big smiles as they slowly swim upward toward the light.
Scene 12: Outro (1:50 - 1:58)
Prompt: Colorful bubbles filling the screen, transitioning to a bright closing screen with the words "The End" appearing in a playful, bubbly font, vibrant underwater background.`;

describe("parseScriptDeterministic", () => {
  it("parses the authored Scene/Prompt format with timings and style", () => {
    const parsed = parseScriptDeterministic(BABY_SHARK_SCRIPT)!;
    expect(parsed).not.toBeNull();
    expect(parsed.scenes).toHaveLength(12);
    expect(parsed.style).toContain("Bright 2D cartoon animation");

    expect(parsed.scenes[0]).toMatchObject({
      index: 1,
      title: "Intro",
      durationSec: 16, // 0:24 - 0:08
    });
    expect(parsed.scenes[0].prompt).toContain("coral reef");

    expect(parsed.scenes[1]).toMatchObject({
      index: 2,
      title: "Baby Shark",
      durationSec: 8, // 0:32 - 0:24
    });

    // Minute boundaries: 1:50 - 1:29 = 21s.
    expect(parsed.scenes[10].durationSec).toBe(21);
    expect(parsed.scenes[11]).toMatchObject({ title: "Outro", durationSec: 8 });
  });

  it("parses scenes without timings (no durationSec)", () => {
    const parsed = parseScriptDeterministic(
      `Scene 1: Opening\nPrompt: A sunrise over mountains.\nScene 2: Closing\nPrompt: A sunset over the sea.`,
    )!;
    expect(parsed.scenes).toHaveLength(2);
    expect(parsed.scenes[0].durationSec).toBeUndefined();
    expect(parsed.scenes[1].prompt).toBe("A sunset over the sea.");
  });

  it("uses the block text when there is no Prompt: label", () => {
    const parsed = parseScriptDeterministic(
      `Scene 1: Only\nA lone astronaut floating in space.`,
    )!;
    expect(parsed.scenes[0].prompt).toBe("A lone astronaut floating in space.");
  });

  it("extracts a Narration: label separately from the prompt", () => {
    const parsed = parseScriptDeterministic(
      [
        "Scene 1: Workshop (0:00 - 0:06)",
        "Prompt: A boy enters a cluttered inventor's workshop,",
        "warm lamplight, 3D animation.",
        "Narration: It all began in grandpa's workshop,",
        "where every gadget told a story.",
        "Scene 2: Reveal (0:06 - 0:12)",
        "Prompt: A small robot blinks awake on the workbench.",
      ].join("\n"),
    )!;
    expect(parsed.scenes).toHaveLength(2);
    expect(parsed.scenes[0].prompt).toBe(
      "A boy enters a cluttered inventor's workshop, warm lamplight, 3D animation.",
    );
    expect(parsed.scenes[0].narration).toBe(
      "It all began in grandpa's workshop, where every gadget told a story.",
    );
    expect(parsed.scenes[1].narration).toBeUndefined();
  });

  it("accepts Voiceover:/VO: as narration aliases", () => {
    const parsed = parseScriptDeterministic(
      `Scene 1: A\nPrompt: A city street.\nVoiceover: Welcome to the future.`,
    )!;
    expect(parsed.scenes[0].narration).toBe("Welcome to the future.");
  });

  it("returns null for free-form text", () => {
    expect(
      parseScriptDeterministic("Make me a fun video about sharks please."),
    ).toBeNull();
  });

  it("clamps absurd scene durations to a generatable range", () => {
    const parsed = parseScriptDeterministic(
      `Scene 1: Long (0:00 - 5:00)\nPrompt: An epic journey.`,
    )!;
    expect(parsed.scenes[0].durationSec).toBe(30);
  });
});

describe("createScriptParser", () => {
  it("prefers the deterministic parse and never calls the LLM", async () => {
    let called = false;
    const parser = createScriptParser(async () => {
      called = true;
      return "{}";
    });
    const parsed = await parser(BABY_SHARK_SCRIPT);
    expect(parsed.scenes).toHaveLength(12);
    expect(called).toBe(false);
  });

  it("falls back to the LLM for free-form scripts", async () => {
    const parser = createScriptParser(async () =>
      JSON.stringify({
        style: "watercolor",
        scenes: [
          { title: "One", prompt: "a watercolor cat", durationSec: 5 },
          { title: "Two", prompt: "a watercolor dog" },
        ],
      }),
    );
    const parsed = await parser("make a cute watercolor pets video");
    expect(parsed.style).toBe("watercolor");
    expect(parsed.scenes).toHaveLength(2);
    expect(parsed.scenes[0]).toMatchObject({ index: 1, durationSec: 5 });
  });

  it("throws a clear error when the LLM output is unusable", async () => {
    const parser = createScriptParser(async () => '{"scenes": []}');
    await expect(parser("free form text")).rejects.toThrow(/scenes/i);
  });

  it("throws a format hint when no LLM is available", async () => {
    const parser = createScriptParser();
    await expect(parser("free form text")).rejects.toThrow(/Scene 1/);
  });
});
