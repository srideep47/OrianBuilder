/**
 * Heuristic: does a prompt look like a multi-scene SCRIPT that should run as a
 * storyboard job (parse → per-scene clips → auto-edit → soundtrack) rather than
 * a single asset or an app build?
 *
 * Matches the authored "Scene N:" header format the script parser reads, or a
 * longer multi-line block with a `Style:` line plus scene/shot cues.
 * Deliberately conservative: ordinary one-liners like "make a cute shark video"
 * fall through to the normal single-video path. Pure, so it's unit-testable
 * without pulling in the command-bar component.
 */
import type { MediaAspectRatio } from "@/ipc/types/media_queue";

export function looksLikeStoryboardScript(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false;
  // Two or more "Scene N" headers → unambiguously a storyboard script.
  const sceneHeaders = t.match(/scene\s*\d+\s*[:.\-)]/gi);
  if (sceneHeaders && sceneHeaders.length >= 2) return true;
  // A "Style:" line plus scene/shot cues across several lines.
  const lines = t.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length >= 4) {
    const hasStyle = /^\s*style\s*:/im.test(t);
    const sceneish = /\b(scene|shot|sequence|storyboard)\b/i.test(t);
    if (hasStyle && sceneish) return true;
  }
  return false;
}

/**
 * Aspect ratio mentioned in (or implied by) a script: an explicit "9:16" /
 * "16x9", or platform/orientation words ("vertical", "portrait", "shorts",
 * "reels" → 9:16; "landscape", "widescreen" → 16:9; "square" → 1:1).
 * Returns null when the script doesn't say — the caller picks the default.
 * Pure, unit-testable.
 */
export function detectAspectRatio(text: string): MediaAspectRatio | null {
  // No whitespace around the separator, so scene headers ("Scene 3: 4
  // friends…") and timings ("0:16") never read as ratios.
  const explicit = text.match(/\b(16|9|4|3|1)[:x×](16|9|4|3|1)\b/i);
  if (explicit) {
    const ratio = `${explicit[1]}:${explicit[2]}`;
    const known: MediaAspectRatio[] = ["16:9", "9:16", "1:1", "4:3", "3:4"];
    const match = known.find((k) => k === ratio);
    if (match) return match;
  }
  if (
    /\b(vertical|portrait|shorts?|reels?|tiktok|story\s*format)\b/i.test(text)
  ) {
    return "9:16";
  }
  if (/\b(landscape|widescreen|cinematic\s+wide|youtube)\b/i.test(text)) {
    return "16:9";
  }
  if (/\bsquare\b/i.test(text)) return "1:1";
  return null;
}
