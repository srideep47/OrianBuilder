import { afterEach, describe, expect, it, vi } from "vitest";

// Mocks

const generateTextMock = vi.fn();
const getModelClientMock = vi.fn(async (..._args: unknown[]) => ({
  modelClient: { model: {}, builtinProviderId: undefined },
}));
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock("@/main/settings", () => ({
  readSettings: () => ({
    selectedModel: { name: "test-model", provider: "test" },
  }),
}));
vi.mock("@/ipc/utils/get_model_client", () => ({
  getModelClient: (...args: unknown[]) => getModelClientMock(...args),
}));
vi.mock("@/ipc/utils/provider_options", () => ({
  getProviderOptions: () => ({}),
  getAiHeaders: () => ({}),
  ORIANBUILDER_INTERNAL_REQUEST_ID_HEADER: "x-req-id",
}));
vi.mock("./capability_registry", () => ({
  listCapabilities: () => [
    { id: "generate_design", label: "design", description: "make design" },
    { id: "generate_image", label: "img", description: "make image" },
    { id: "generate_3d_asset", label: "3d", description: "make 3d" },
    { id: "research_news", label: "news", description: "research news" },
    { id: "track_website", label: "watch", description: "track site" },
    { id: "track_price", label: "price", description: "track price" },
    { id: "build_app", label: "build", description: "build app" },
  ],
}));

import { parseIntent, fallbackParse } from "./intent_parser";

afterEach(() => {
  vi.clearAllMocks();
});

describe("fallbackParse", () => {
  it("creates an image step and a build step for an app+image command", () => {
    const intent = fallbackParse("build a todo app with a hero image", 7);
    expect(intent.appId).toBe(7);
    const caps = intent.steps.map((s) => s.capability);
    expect(caps).toContain("generate_image");
    expect(caps).toContain("build_app");
    // build should depend on the image step
    const build = intent.steps.find((s) => s.capability === "build_app");
    expect(build?.dependsOn?.length).toBeGreaterThan(0);
  });

  it("defaults to a single build_app step when nothing matches", () => {
    const intent = fallbackParse("do something vague");
    expect(intent.steps).toHaveLength(1);
    expect(intent.steps[0].capability).toBe("build_app");
  });

  it("creates only a media step for a pure image command", () => {
    const intent = fallbackParse("generate a picture of a cat");
    expect(intent.steps.some((s) => s.capability === "generate_image")).toBe(
      true,
    );
    expect(intent.steps.some((s) => s.capability === "build_app")).toBe(false);
  });

  it("creates a design step before build for UI app commands", () => {
    const intent = fallbackParse("build a dashboard app with a polished UI");
    expect(intent.steps[0].capability).toBe("generate_design");
    const build = intent.steps.find((s) => s.capability === "build_app");
    expect(build?.dependsOn).toContain("design-1");
  });

  it("creates image and 3D steps for text-to-3D commands", () => {
    const intent = fallbackParse("generate a 3D game asset of a robot");
    expect(intent.steps.map((s) => s.capability)).toEqual([
      "generate_image",
      "generate_3d_asset",
    ]);
    expect(intent.steps[1].dependsOn).toEqual(["image-1"]);
  });

  it("routes music/song commands to generate_music, not speech", () => {
    const intent = fallbackParse("make a lo-fi song with a chill beat");
    const caps = intent.steps.map((s) => s.capability);
    expect(caps).toContain("generate_music");
    expect(caps).not.toContain("generate_audio");
  });

  it("routes narration/voice commands to generate_audio (speech)", () => {
    const intent = fallbackParse("narrate a calm voiceover welcoming the user");
    const caps = intent.steps.map((s) => s.capability);
    expect(caps).toContain("generate_audio");
    expect(caps).not.toContain("generate_music");
  });

  it("routes news commands to the digest capability", () => {
    const intent = fallbackParse("show me latest AI news headlines");
    expect(intent.steps.some((s) => s.capability === "research_news")).toBe(
      true,
    );
  });

  it("routes price tracking commands to Watchdog", () => {
    const intent = fallbackParse("track price for https://example.com/item");
    const step = intent.steps.find((s) => s.capability === "track_price");
    expect(step?.input.url).toBe("https://example.com/item");
  });

  it("routes website and price tracking when both are requested", () => {
    const intent = fallbackParse(
      "monitor https://example.com/news and track price for https://example.com/item",
    );
    const caps = intent.steps.map((s) => s.capability);
    expect(caps).toContain("track_website");
    expect(caps).toContain("track_price");
    expect(
      intent.steps.find((s) => s.capability === "track_website")?.input.url,
    ).toBe("https://example.com/news");
    expect(
      intent.steps.find((s) => s.capability === "track_price")?.input.url,
    ).toBe("https://example.com/item");
  });

  it("does not treat a generic AI model request as a 3D asset", () => {
    const intent = fallbackParse("load the last selected llm model");
    expect(intent.steps.some((s) => s.capability === "generate_3d_asset")).toBe(
      false,
    );
  });

  it("routes a full Orion workflow prompt across design, media, 3D, news, tracking, and build", () => {
    const intent = fallbackParse(
      "Build a market intelligence app with a polished UI screen, hero image, 3D GLB asset, latest AI news, monitor https://example.com/news, and track price for https://example.com/item",
    );
    const caps = intent.steps.map((s) => s.capability);
    expect(caps).toEqual(
      expect.arrayContaining([
        "generate_design",
        "generate_image",
        "generate_3d_asset",
        "research_news",
        "track_website",
        "track_price",
        "build_app",
      ]),
    );
    const build = intent.steps.find((s) => s.capability === "build_app");
    expect(build?.dependsOn).toEqual(
      expect.arrayContaining([
        "design-1",
        "image-1",
        "3d-asset-1",
        "news-1",
        "website-track-1",
        "price-track-1",
      ]),
    );
  });
});

describe("parseIntent", () => {
  it("routes an obvious image command without loading the coding LLM", async () => {
    const intent = await parseIntent(
      "Generate a cinematic hero image of a mountain sunrise",
      12,
    );

    expect(intent.appId).toBe(12);
    expect(intent.steps.map((step) => step.capability)).toEqual([
      "generate_image",
    ]);
    expect(getModelClientMock).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("uses the LLM output when it is valid JSON", async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        goal: "Build a todo app",
        steps: [
          {
            id: "hero",
            capability: "generate_image",
            description: "hero",
            input: { prompt: "a hero image" },
          },
          {
            id: "build",
            capability: "build_app",
            description: "build",
            input: { goal: "todo app" },
            dependsOn: ["hero"],
          },
        ],
      }),
    });

    const intent = await parseIntent("build a todo app with a hero", 3);
    expect(intent.appId).toBe(3);
    expect(intent.steps).toHaveLength(2);
    expect(intent.steps[0].capability).toBe("generate_image");
  });

  it("strips markdown fences before parsing", async () => {
    generateTextMock.mockResolvedValue({
      text: '```json\n{"goal":"x","steps":[{"id":"b","capability":"build_app","input":{}}]}\n```',
    });
    const intent = await parseIntent("make an app");
    expect(intent.steps[0].capability).toBe("build_app");
  });

  it("falls back to keyword parsing when the LLM returns garbage", async () => {
    generateTextMock.mockResolvedValue({ text: "not json at all !!!" });
    const intent = await parseIntent("build an app with an image", 9);
    expect(intent.appId).toBe(9);
    expect(intent.steps.some((s) => s.capability === "build_app")).toBe(true);
  });

  it("falls back when the LLM throws", async () => {
    generateTextMock.mockRejectedValue(new Error("model offline"));
    const intent = await parseIntent("build an app");
    expect(intent.steps.length).toBeGreaterThan(0);
  });
});
