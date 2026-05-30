import crypto from "node:crypto";
import { generateText } from "ai";
import { jsonrepair } from "jsonrepair";
import log from "electron-log";
import { readSettings } from "@/main/settings";
import { getModelClient } from "@/ipc/utils/get_model_client";
import {
  getProviderOptions,
  getAiHeaders,
  ORIANBUILDER_INTERNAL_REQUEST_ID_HEADER,
} from "@/ipc/utils/provider_options";
import {
  CommandIntentSchema,
  type CommandIntent,
  type CapabilityId,
} from "@/ipc/types/intent";
import { listCapabilities } from "./capability_registry";

const logger = log.scope("intent-parser");

/**
 * The LLM is asked to return ONLY this shape (goal + steps). appId/constraints
 * are merged in by the parser from the request, not the model.
 */
const LlmIntentSchema = CommandIntentSchema.pick({ goal: true, steps: true });

function buildSystemPrompt(): string {
  const caps = listCapabilities()
    .map((c) => `  - "${c.id}": ${c.description}`)
    .join("\n");
  return `You are the intent router for OrianBuilder, an AI software factory.
Convert the user's command into a structured JSON plan of capability steps.

Available capabilities:
${caps}

Rules:
- Output ONLY valid JSON. No prose, no markdown fences.
- Shape: {"goal": string, "steps": [{"id": string, "capability": string, "description": string, "input": object, "dependsOn": string[] }]}
- "capability" MUST be one of the ids listed above.
- Order design and media steps BEFORE "build_app", and make the build step
  "dependsOn" those step ids so the build can reference generated assets and
  implement generated designs.
- Use "generate_design" for UI design, layout, wireframe, mockup, prototype,
  theme, or Design Studio requests.
- Use "generate_3d_asset" for 3D model, GLB, mesh, object, or game asset
  requests. If the user only gives text, create a "generate_image" reference
  step first and make the 3D step depend on it.
- Use "research_news" for current news, headlines, digest, market/sports/science
  news, or research-current-events requests.
- Use "track_website" for website monitoring/change detection requests.
- Use "track_price" for product price tracking requests.
- For design steps, put a detailed UI/design prompt in input.prompt.
- For media steps, put a detailed generation prompt in input.prompt.
- For tracking steps, put the URL in input.url when present and the original
  request in input.prompt.
- For a "build_app" step, put the full app description in input.goal.
- Keep step ids short and kebab-case (e.g. "hero-image", "build").
- If the command is only about generating media, omit build_app.
- If the command is only about building an app, use a single build_app step.

Example command: "build a todo app with a custom hero image and a node backend"
Example output:
{"goal":"Build a todo app with a custom hero image and a Node backend","steps":[{"id":"ui-design","capability":"generate_design","description":"UI design direction for the todo app","input":{"prompt":"A polished todo app UI with a focused task list, quick-add composer, filters, empty state, and responsive dashboard layout"}},{"id":"hero-image","capability":"generate_image","description":"Hero image for the todo app","input":{"prompt":"A clean modern hero illustration of an organized todo list, soft gradients, blue and purple palette, minimal flat design"}},{"id":"build","capability":"build_app","description":"Scaffold and implement the todo app with a Node backend","input":{"goal":"A todo app (React frontend + Node/Express backend) with create/complete/delete tasks, using the generated UI design and hero image"},"dependsOn":["ui-design","hero-image"]}]}`;
}

const DESIGN_KEYWORDS = [
  "design",
  "ui",
  "ux",
  "wireframe",
  "mockup",
  "prototype",
  "layout",
  "screen",
  "theme",
  "style",
  "figma",
];

const THREE_D_KEYWORDS = [
  "3d",
  "3-d",
  "three d",
  "glb",
  "gltf",
  "mesh",
  "object",
  "game asset",
  "asset pack",
  "character",
];

const NEWS_KEYWORDS = [
  "news",
  "headline",
  "headlines",
  "digest",
  "current events",
  "latest",
  "today",
  "market",
  "sports",
  "science",
  "technology",
  "business",
];

const WEBSITE_TRACKING_KEYWORDS = [
  "watch",
  "monitor",
  "track website",
  "website tracking",
  "changes",
  "change detection",
  "radar",
];

const PRICE_TRACKING_KEYWORDS = [
  "track price",
  "price tracking",
  "price monitor",
  "watch price",
  "product price",
  "target price",
];

const MEDIA_KEYWORDS: Record<
  Extract<CapabilityId, "generate_image" | "generate_audio" | "generate_video">,
  string[]
> = {
  generate_image: [
    "image",
    "picture",
    "photo",
    "hero",
    "logo",
    "icon",
    "illustration",
    "banner",
    "graphic",
    "artwork",
  ],
  generate_audio: [
    "audio",
    "voice",
    "voiceover",
    "narration",
    "speech",
    "sound",
    "music",
    "song",
  ],
  generate_video: ["video", "animation", "clip", "movie", "trailer"],
};

const BUILD_KEYWORDS = [
  "app",
  "build",
  "website",
  "site",
  "frontend",
  "backend",
  "page",
  "dashboard",
  "landing",
  "api",
  "component",
  "feature",
];

/**
 * Deterministic fallback used when no LLM is available or the model returns
 * invalid output. Keyword-based, never throws.
 */
export function fallbackParse(text: string, appId?: number): CommandIntent {
  const lower = text.toLowerCase();
  const steps: CommandIntent["steps"] = [];
  const assetStepIds: string[] = [];
  const urls = [...text.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(
    (match) => match[0],
  );
  const firstUrl = urls[0];
  const lastUrl = urls[urls.length - 1];

  if (DESIGN_KEYWORDS.some((kw) => lower.includes(kw))) {
    steps.push({
      id: "design-1",
      capability: "generate_design",
      description: "Auto-detected design step",
      input: { prompt: text },
    });
    assetStepIds.push("design-1");
  }

  (Object.keys(MEDIA_KEYWORDS) as Array<keyof typeof MEDIA_KEYWORDS>).forEach(
    (cap) => {
      if (MEDIA_KEYWORDS[cap].some((kw) => lower.includes(kw))) {
        const id = cap.replace("generate_", "") + "-1";
        steps.push({
          id,
          capability: cap,
          description: `Auto-detected ${cap} step`,
          input: { prompt: text },
        });
        assetStepIds.push(id);
      }
    },
  );

  if (THREE_D_KEYWORDS.some((kw) => lower.includes(kw))) {
    let imageStepId = assetStepIds.find((id) => id.startsWith("image-"));
    if (!imageStepId) {
      imageStepId = "image-1";
      steps.push({
        id: imageStepId,
        capability: "generate_image",
        description: "Reference image for 3D asset generation",
        input: { prompt: text },
      });
      assetStepIds.push(imageStepId);
    }
    steps.push({
      id: "3d-asset-1",
      capability: "generate_3d_asset",
      description: "Generate a 3D asset from the reference image",
      input: { prompt: text },
      dependsOn: [imageStepId],
    });
    assetStepIds.push("3d-asset-1");
  }

  if (NEWS_KEYWORDS.some((kw) => lower.includes(kw))) {
    steps.push({
      id: "news-1",
      capability: "research_news",
      description: "Fetch current news for the requested topic",
      input: { query: text },
    });
    assetStepIds.push("news-1");
  }

  if (PRICE_TRACKING_KEYWORDS.some((kw) => lower.includes(kw))) {
    steps.push({
      id: "price-track-1",
      capability: "track_price",
      description: "Track a product price in Watchdog",
      input: { prompt: text, url: lastUrl ?? firstUrl },
    });
    assetStepIds.push("price-track-1");
  }

  if (WEBSITE_TRACKING_KEYWORDS.some((kw) => lower.includes(kw))) {
    steps.push({
      id: "website-track-1",
      capability: "track_website",
      description: "Track a website in Watchdog",
      input: { prompt: text, url: firstUrl },
    });
    assetStepIds.push("website-track-1");
  }

  const wantsBuild = BUILD_KEYWORDS.some((kw) => lower.includes(kw));
  if (wantsBuild || steps.length === 0) {
    steps.push({
      id: "build",
      capability: "build_app",
      description: "Build the requested application",
      input: { goal: text },
      dependsOn: assetStepIds.length ? assetStepIds : undefined,
    });
  }

  return { goal: text, steps, appId };
}

function extractJson(raw: string): string {
  let s = raw.trim();
  // Strip ```json ... ``` fences if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s;
}

/**
 * Parse a free-text command into a structured CommandIntent. Uses the user's
 * selected model (local-first ethos honored by the selected-model + remote
 * routing layers); falls back to a deterministic keyword parser on any error.
 */
export async function parseIntent(
  text: string,
  appId?: number,
): Promise<CommandIntent> {
  let settings;
  try {
    settings = readSettings();
  } catch (err) {
    logger.warn("readSettings failed; using fallback parser", err);
    return fallbackParse(text, appId);
  }

  try {
    const { modelClient } = await getModelClient(
      settings.selectedModel,
      settings,
    );
    const requestId = crypto.randomUUID();
    const { text: out } = await generateText({
      model: modelClient.model,
      headers: {
        ...getAiHeaders({ builtinProviderId: modelClient.builtinProviderId }),
        [ORIANBUILDER_INTERNAL_REQUEST_ID_HEADER]: requestId,
      },
      providerOptions: getProviderOptions({
        orianbuilderAppId: 0,
        orianbuilderRequestId: requestId,
        orianbuilderDisableFiles: true,
        files: [],
        mentionedAppsCodebases: [],
        builtinProviderId: modelClient.builtinProviderId,
        settings,
      }),
      system: buildSystemPrompt(),
      prompt: text,
      maxRetries: 2,
    });

    const parsed = JSON.parse(jsonrepair(extractJson(out)));
    const validated = LlmIntentSchema.safeParse(parsed);
    if (!validated.success) {
      logger.warn(
        `LLM intent failed validation: ${validated.error.message}; using fallback`,
      );
      return fallbackParse(text, appId);
    }
    if (validated.data.steps.length === 0) {
      return fallbackParse(text, appId);
    }
    return { ...validated.data, appId };
  } catch (err) {
    logger.warn("LLM intent parse failed; using fallback", err);
    return fallbackParse(text, appId);
  }
}
