import { jsonrepair } from "jsonrepair";
import log from "electron-log";
import {
  AssetManifestSchema,
  validateManifest,
  type AssetManifest,
  type AssetType,
} from "@/ipc/types/manifest";
import type { HardwareModelProfile } from "./model_profiles";

// =============================================================================
// Orion Orchestrated Pipeline — Asset Manifest Planner (Phase A brain)
// =============================================================================
//
// Phase A's LLM job: turn the user's goal into the structured asset manifest the
// rest of the pipeline batches over. The LLM call is INJECTED (`GenerateTextFn`)
// so the prompt-building + parse + validation logic is unit-testable without a
// model. `defaultGenerateText` (in pipeline_wiring.ts) provides the real call.
//
// Resilient by design: any parse/validation failure yields an EMPTY manifest so
// the build still proceeds (just with no generated assets) rather than aborting.
// See plans/orion-orchestrated-pipeline.md.
// =============================================================================

const logger = log.scope("asset-planner");

export type GenerateTextFn = (args: {
  system: string;
  prompt: string;
}) => Promise<string>;

/** Modalities a profile actually supports in this flow (image/video/music/3d
 *  minus anything disabled). TTS/transcribe are never asset modalities. */
function enabledModalities(profile: HardwareModelProfile): AssetType[] {
  // All four asset modalities are supported by the pipeline; `disabledModalities`
  // only covers tts/transcribe, which are not AssetTypes, so nothing to filter.
  void profile;
  return ["image", "video", "music", "3d"];
}

export function buildPlannerSystemPrompt(
  profile: HardwareModelProfile,
): string {
  const mods = enabledModalities(profile).join(", ");
  return `You are the asset planner for OrianBuilder, an autonomous AI software factory.
Given a build request, produce the COMPLETE list of media assets the finished app
will need, as structured JSON. A separate code phase will reference these assets
by their exact filenames, and a generation phase will create them — so you must
declare every asset up front with a ready-to-run generation prompt.

Available asset types: ${mods}.

Rules:
- Output ONLY valid JSON. No prose, no markdown fences.
- Shape: {"assets":[{"id":string,"type":string,"targetFilename":string,"prompt":string,"settings":object,"refAssetId":string}]}
- "type" MUST be one of: ${mods}.
- "targetFilename" is a relative path the code will reference, e.g. "assets/hero.png",
  "assets/promo.mp4", "assets/theme.wav", "assets/mascot.glb". Use the right
  extension for the type (image=.png, video=.mp4, music=.wav, 3d=.glb). Make every
  targetFilename unique.
- "prompt" is a detailed, self-contained generation prompt for that single asset.
- "settings" is optional per-asset overrides (e.g. {"width":1024} for images,
  {"seconds":5} for video). Omit or use {} when defaults are fine.
- For a 3d asset, FIRST add an image asset to serve as its reference, then set the
  3d asset's "refAssetId" to that image asset's id. 3d refs MUST be images.
- Only include assets the app genuinely needs. Prefer a handful of high-impact
  assets over many. If the app needs no media, return {"assets":[]}.

Example request: "a landing page for a coffee shop with a logo and a short promo video"
Example output:
{"assets":[{"id":"logo","type":"image","targetFilename":"assets/logo.png","prompt":"Minimal flat logo for a specialty coffee shop, warm browns and cream, a stylized coffee bean mark, vector style on transparent background","settings":{"width":768,"height":768}},{"id":"promo","type":"video","targetFilename":"assets/promo.mp4","prompt":"Cozy 5-second promo clip: steam rising from a fresh espresso cup on a wooden counter, warm morning light, shallow depth of field","settings":{"seconds":5}}]}`;
}

function extractJson(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s;
}

/**
 * Generate the asset manifest for a build. Never throws — returns an empty
 * (but valid) manifest on any failure so the pipeline degrades gracefully.
 */
export async function generateAssetManifest(args: {
  buildId: string;
  goal: string;
  profile: HardwareModelProfile;
  generate: GenerateTextFn;
}): Promise<AssetManifest> {
  const { buildId, goal, profile, generate } = args;
  const empty: AssetManifest = { buildId, assets: [] };

  let raw: string;
  try {
    raw = await generate({
      system: buildPlannerSystemPrompt(profile),
      prompt: goal,
    });
  } catch (err) {
    logger.warn(`planner LLM call failed; no assets: ${String(err)}`);
    return empty;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(jsonrepair(extractJson(raw)));
  } catch (err) {
    logger.warn(`planner output not JSON; no assets: ${String(err)}`);
    return empty;
  }

  const assets =
    parsedJson && typeof parsedJson === "object" && "assets" in parsedJson
      ? (parsedJson as { assets: unknown }).assets
      : parsedJson;

  const result = AssetManifestSchema.safeParse({ buildId, assets });
  if (!result.success) {
    logger.warn(`planner manifest invalid; no assets: ${result.error.message}`);
    return empty;
  }

  const validation = validateManifest(result.data);
  if (!validation.ok) {
    logger.warn(
      `planner manifest has structural issues (continuing): ${validation.errors.join("; ")}`,
    );
  }
  logger.info(
    `planner produced ${result.data.assets.length} assets for build ${buildId}`,
  );
  return result.data;
}
