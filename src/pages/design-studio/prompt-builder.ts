import type { DesignSkill, DesignSystem, CraftRule } from "@/ipc/types";
import type { DesignMode, FidelityLevel, DirectionId } from "./constants";
import {
  MODE_DIRECTIVES,
  FIDELITY_DIRECTIVES,
  VISUAL_DIRECTIONS,
} from "./constants";

const SYSTEM_BASE = `You are an expert UI/UX designer and frontend developer producing beautiful, production-ready HTML/CSS/JS designs.

## ARTIFACT OUTPUT RULE — MANDATORY
Every response MUST end with a complete HTML document wrapped exactly like this:

<artifact type="html" title="[Short descriptive title]">
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>...</title>
  <!-- Google Fonts CDN link here if needed -->
  <style>/* All CSS inline */</style>
</head>
<body>
  <!-- Complete implementation -->
  <script>/* All JS inline */</script>
</body>
</html>
</artifact>

## Core Design Standards
- CSS custom properties (--bg, --fg, --accent, etc.) for all colours — never hardcode hex directly in components
- Generous spacing (padding: 2rem+ on sections)
- Rich micro-interactions: hover states, smooth transitions, focus rings
- Typography: real hierarchy with size + weight + spacing differentiation
- Never truncate — output the FULL implementation every single time
- When iterating on an existing design: output the COMPLETE updated HTML`;

export interface PromptParams {
  mode: DesignMode;
  fidelity: FidelityLevel;
  skill: DesignSkill | null;
  designSystem: DesignSystem | null;
  designSystemTokens: string | null;
  craftRules: CraftRule[];
  activeCraftRuleIds: string[];
  direction: DirectionId | null;
  audience: string;
  tone: string;
  currentArtifact: string | null;
}

export function buildSystemPrompt(p: PromptParams): string {
  const parts: string[] = [SYSTEM_BASE];

  // Mode
  parts.push(`\n---\n## Project Mode\n${MODE_DIRECTIVES[p.mode]}`);

  // Fidelity
  parts.push(`\n---\n## Fidelity Level\n${FIDELITY_DIRECTIVES[p.fidelity]}`);

  // Visual direction
  if (p.direction) {
    const dir = VISUAL_DIRECTIONS.find((d) => d.id === p.direction);
    if (dir) {
      parts.push(
        `\n---\n## Visual Direction: ${dir.name}\n${dir.description}\n\nApply these CSS tokens to :root:\n\`\`\`css\n:root { ${dir.cssTokens} }\n\`\`\`${dir.googleFonts ? `\n\nInclude this Google Fonts link in <head>:\n<link rel="preconnect" href="https://fonts.googleapis.com">\n<link href="${dir.googleFonts}" rel="stylesheet">` : ""}`,
      );
    }
  }

  // Audience + tone (from discovery form)
  if (p.audience || p.tone) {
    const lines: string[] = [];
    if (p.audience) lines.push(`- Target audience: ${p.audience}`);
    if (p.tone) lines.push(`- Tone: ${p.tone}`);
    parts.push(`\n---\n## Project Brief\n${lines.join("\n")}`);
  }

  // Design system
  if (p.designSystem) {
    parts.push(
      `\n---\n## Active Design System: ${p.designSystem.name}\n${p.designSystem.content.slice(0, 6000)}`,
    );
    if (p.designSystemTokens) {
      parts.push(
        `\n### Design System CSS Tokens\nApply these to :root in your artifact:\n\`\`\`css\n${p.designSystemTokens}\n\`\`\``,
      );
    }
  }

  // Skill
  if (p.skill) {
    parts.push(`\n---\n## Active Skill: ${p.skill.name}\n${p.skill.content}`);
  }

  // Active craft rules (first 3000 chars each to keep prompt manageable)
  const activeCraft = p.craftRules.filter((r) =>
    p.activeCraftRuleIds.includes(r.id),
  );
  if (activeCraft.length > 0) {
    parts.push(
      `\n---\n## Craft Rules (apply these guidelines)\n` +
        activeCraft
          .map((r) => `### ${r.name}\n${r.content.slice(0, 3000)}`)
          .join("\n\n"),
    );
  }

  // Current artifact (for iteration)
  if (p.currentArtifact) {
    parts.push(
      `\n---\n## Current Design (for iteration)\nWhen making changes, output the COMPLETE updated HTML — never partial.\n\n\`\`\`html\n${p.currentArtifact.slice(0, 10000)}\n\`\`\``,
    );
  }

  return parts.join("");
}

// Append a per-message reminder so quantized local models stay on-format
export function withArtifactReminder(userText: string): string {
  return `${userText}\n\n[Required: end your response with the complete HTML inside <artifact type="html" title="...">...</artifact>]`;
}

// Build a self-critique prompt from an artifact
export function buildCritiquePrompt(artifactHtml: string): string {
  return `Review the HTML design below and score it on 5 dimensions (each 1-10). Reply with ONLY valid JSON — no other text, no markdown fences.

{"philosophy":<int>,"hierarchy":<int>,"detail":<int>,"function":<int>,"innovation":<int>,"summary":"<one-sentence verdict>"}

Scoring criteria:
- philosophy: Clear, intentional design point of view
- hierarchy: Visual hierarchy guides the eye correctly
- detail: Execution polish — spacing, transitions, states
- function: Solves the design problem effectively
- innovation: Fresh, non-generic choices

HTML to review (truncated):
${artifactHtml.slice(0, 3000)}`;
}
