import { describe, expect, it } from "vitest";
import { formatOrionMediaReply } from "./orion_media_reply";

describe("formatOrionMediaReply", () => {
  it("persists a rich inline media result with escaped attributes", () => {
    const reply = formatOrionMediaReply("mountain & sunrise", [
      {
        capability: "generate_image",
        kind: "image",
        mimeType: "image/png",
        prompt: 'mountain & "sunrise"',
        relativePath: ".orianbuilder/media/hero.png",
        absolutePath: "D:/media/hero.png",
        durationMs: 1200,
      },
    ]);

    expect(reply).toContain("<orianbuilder-media-generation");
    expect(reply).toContain('kind="image"');
    expect(reply).toContain("mountain &amp; &quot;sunrise&quot;");
    expect(reply).toContain('duration-ms="1200"');
  });

  it("surfaces runtime setup failures as a chat reply", () => {
    expect(
      formatOrionMediaReply("make a video", [
        {
          capability: "generate_video",
          kind: "video",
          mimeType: "video/mp4",
          prompt: "make a video",
          error: "runtime missing",
          setupRoute: "/media-runtime",
        },
      ]),
    ).toContain("Set up the local media runtime");
  });
});
