import log from "electron-log";
import { jsonrepair } from "jsonrepair";
import { z } from "zod";
import type { GenerateTextFn } from "@/main/flow/asset_planner";

// =============================================================================
// Orion Media Queue — storyboard script parser
// =============================================================================
//
// Turns a big multi-scene script into structured scenes the queue can generate
// one by one. Deterministic-first: the common authored format
//
//   Style: Bright 2D cartoon animation, ...
//   Scene 1: Intro (0:08 - 0:24)
//   Prompt: A beautiful, bright underwater coral reef scene ...
//
// parses with a regex — no model needed. Free-form scripts fall back to the
// injected LLM (the user's selected model), validated with zod. The optional
// `style` line is captured separately so it can be prepended to EVERY scene
// prompt — that's what keeps characters/palette consistent across clips.
// =============================================================================

const logger = log.scope("script-parser");

export interface StoryboardScene {
  /** 1-based scene number in playback order. */
  index: number;
  title: string;
  prompt: string;
  /** Target clip length in seconds, when derivable from the script. */
  durationSec?: number;
}

export interface ParsedStoryboard {
  /** Global style hint prepended to every scene prompt for consistency. */
  style?: string;
  scenes: StoryboardScene[];
}

/** "0:24" or "1:08" → seconds. */
function timeToSeconds(min: string, sec: string): number {
  return Number(min) * 60 + Number(sec);
}

const SCENE_HEADER_RE =
  /^\s*(?:#+\s*)?Scene\s+(\d+)\s*[:.-]?\s*([^\n(]*?)\s*(?:\((\d+):(\d{1,2})\s*[-–—]\s*(\d+):(\d{1,2})\))?\s*$/im;

/** Clamp a scene clip to something a video model can actually produce. */
function clampDuration(seconds: number): number {
  return Math.max(2, Math.min(30, Math.round(seconds)));
}

/**
 * Parse the authored "Scene N: Title (m:ss - m:ss) / Prompt: …" format.
 * Returns null when the script doesn't look like that format (<1 scene).
 */
export function parseScriptDeterministic(
  script: string,
): ParsedStoryboard | null {
  const lines = script.split(/\r?\n/);

  // Find scene header line indices.
  const headers: Array<{
    line: number;
    index: number;
    title: string;
    startSec?: number;
    endSec?: number;
  }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SCENE_HEADER_RE);
    if (!m) continue;
    headers.push({
      line: i,
      index: Number(m[1]),
      title: (m[2] || `Scene ${m[1]}`).trim().replace(/[:\-–]\s*$/, ""),
      startSec: m[3] != null ? timeToSeconds(m[3], m[4]) : undefined,
      endSec: m[5] != null ? timeToSeconds(m[5], m[6]) : undefined,
    });
  }
  if (headers.length === 0) return null;

  // Global style: a "Style:" line anywhere before the first scene header.
  let style: string | undefined;
  for (let i = 0; i < headers[0].line; i++) {
    const m = lines[i].match(/^\s*Style\s*:\s*(.+)$/i);
    if (m) style = m[1].trim();
  }

  const scenes: StoryboardScene[] = [];
  for (let h = 0; h < headers.length; h++) {
    const header = headers[h];
    const blockEnd =
      h + 1 < headers.length ? headers[h + 1].line : lines.length;
    const block = lines.slice(header.line + 1, blockEnd).join("\n");

    // Prefer an explicit "Prompt:" label; otherwise use the whole block.
    const promptMatch = block.match(/Prompt\s*:\s*([\s\S]+)/i);
    const prompt = (promptMatch ? promptMatch[1] : block)
      .trim()
      .replace(/\s+/g, " ");
    if (!prompt) continue;

    const durationSec =
      header.startSec != null && header.endSec != null
        ? clampDuration(header.endSec - header.startSec)
        : undefined;

    scenes.push({
      index: header.index,
      title: header.title || `Scene ${header.index}`,
      prompt,
      durationSec,
    });
  }
  if (scenes.length === 0) return null;

  // Keep playback order as authored.
  scenes.sort((a, b) => a.index - b.index);
  return { style, scenes };
}

// ── LLM fallback for free-form scripts ───────────────────────────────────────

const LlmStoryboardSchema = z.object({
  style: z.string().optional(),
  scenes: z
    .array(
      z.object({
        title: z.string(),
        prompt: z.string().min(1),
        durationSec: z.number().positive().max(120).optional(),
      }),
    )
    .min(1),
});

const PARSE_SYSTEM_PROMPT = `You convert a video script into a structured storyboard JSON.
Rules:
- Output ONLY valid JSON. No prose, no markdown fences.
- Shape: {"style": string?, "scenes": [{"title": string, "prompt": string, "durationSec": number?}]}
- Each scene's "prompt" must be a complete, self-contained visual generation
  prompt (subject, action, setting, camera) usable by a text-to-video model.
- "style" is the overall visual style applied to every scene, if the script
  implies one.
- "durationSec" per scene when the script gives timings; omit otherwise.
- Keep the scenes in playback order. Aim for 2-15 second scenes.`;

function extractJson(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s;
}

/**
 * Build the full parser: deterministic format first, LLM fallback for
 * free-form scripts. Throws with a clear message when neither works.
 */
export function createScriptParser(
  generate?: GenerateTextFn,
): (script: string) => Promise<ParsedStoryboard> {
  return async (script: string) => {
    const deterministic = parseScriptDeterministic(script);
    if (deterministic) {
      logger.info(
        `parsed script deterministically: ${deterministic.scenes.length} scene(s)`,
      );
      return deterministic;
    }

    if (!generate) {
      throw new Error(
        'Could not parse the script. Use the "Scene 1: Title (0:00 - 0:10)" + "Prompt: …" format, or enable an LLM for free-form scripts.',
      );
    }

    const raw = await generate({
      system: PARSE_SYSTEM_PROMPT,
      prompt: script,
    });
    const parsed = LlmStoryboardSchema.safeParse(
      JSON.parse(jsonrepair(extractJson(raw))),
    );
    if (!parsed.success) {
      throw new Error(
        `The model could not break this script into scenes (${parsed.error.issues[0]?.message ?? "invalid output"}). Try the "Scene N: … / Prompt: …" format.`,
      );
    }
    const scenes = parsed.data.scenes.map((s, i) => ({
      index: i + 1,
      title: s.title,
      prompt: s.prompt,
      durationSec:
        s.durationSec != null ? clampDuration(s.durationSec) : undefined,
    }));
    logger.info(`parsed script via LLM: ${scenes.length} scene(s)`);
    return { style: parsed.data.style, scenes };
  };
}
