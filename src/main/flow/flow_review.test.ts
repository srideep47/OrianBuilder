import { describe, expect, it } from "vitest";
import { createLlmFlowReviewer, parseReviewVerdict } from "./flow_review";
import type { FlowReviewCheckpoint } from "./flow_review";

function checkpoint(
  upcoming: FlowReviewCheckpoint["upcoming"],
): FlowReviewCheckpoint {
  return {
    goal: "promo kit for a coffee brand",
    completedBatch: [
      {
        stepId: "logo",
        capability: "generate_image",
        prompt: "a coffee logo",
        outputPath: "/tmp/logo.png",
      },
    ],
    upcoming,
  };
}

describe("parseReviewVerdict", () => {
  it("keeps revisions that target known upcoming steps", () => {
    const verdict = parseReviewVerdict(
      JSON.stringify({
        revisions: { promo: "a promo video matching the brown coffee logo" },
      }),
      new Set(["promo"]),
    );
    expect(verdict?.promptRevisions).toEqual({
      promo: "a promo video matching the brown coffee logo",
    });
  });

  it("strips markdown fences and repairs sloppy JSON", () => {
    const verdict = parseReviewVerdict(
      "```json\n{revisions: {promo: 'revised'}}\n```",
      new Set(["promo"]),
    );
    expect(verdict?.promptRevisions).toEqual({ promo: "revised" });
  });

  it("drops unknown step ids and non-string prompts", () => {
    const verdict = parseReviewVerdict(
      JSON.stringify({
        revisions: { ghost: "nope", promo: 42, music: "   " },
      }),
      new Set(["promo", "music"]),
    );
    expect(verdict?.promptRevisions).toEqual({});
  });

  it("yields no revisions for non-JSON prose", () => {
    // jsonrepair coerces prose into a JSON string, so this parses but carries
    // no revisions object — the safe no-op outcome either way.
    const verdict = parseReviewVerdict("not even close", new Set(["promo"]));
    expect(verdict?.promptRevisions ?? {}).toEqual({});
  });
});

describe("createLlmFlowReviewer", () => {
  it("returns the parsed verdict from the model reply", async () => {
    const reviewer = createLlmFlowReviewer(async () =>
      JSON.stringify({ revisions: { promo: "better prompt" } }),
    );
    const verdict = await reviewer(
      checkpoint([
        { stepId: "promo", capability: "generate_video", prompt: "a video" },
      ]),
    );
    expect(verdict?.promptRevisions).toEqual({ promo: "better prompt" });
  });

  it("returns null without calling the model when nothing is upcoming", async () => {
    let called = false;
    const reviewer = createLlmFlowReviewer(async () => {
      called = true;
      return "{}";
    });
    expect(await reviewer(checkpoint([]))).toBeNull();
    expect(called).toBe(false);
  });

  it("never throws when the model call fails", async () => {
    const reviewer = createLlmFlowReviewer(async () => {
      throw new Error("model offline");
    });
    const verdict = await reviewer(
      checkpoint([
        { stepId: "promo", capability: "generate_video", prompt: "a video" },
      ]),
    );
    expect(verdict).toBeNull();
  });
});
