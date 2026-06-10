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
