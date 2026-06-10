import log from "electron-log";
import { jsonrepair } from "jsonrepair";
import type { CapabilityId } from "@/ipc/types/intent";
import type { GenerateTextFn } from "./asset_planner";

// =============================================================================
// Orion Flow — Mid-flow review checkpoints (Phase 0 hardening)
// =============================================================================
//
// Small-model plans are written once, up front, and never see what generation
// actually produced. A FlowReviewer closes that loop: at each modality-batch
// boundary the flow runner hands it what was just generated plus the still-
// pending steps, and the reviewer may revise the pending prompts so later
// assets stay consistent with the goal and with each other.
//
// The reviewer is INJECTED (like the capability executors) so this module and
// the flow runner stay free of model-client imports and fully unit-testable.
// `createLlmFlowReviewer` builds the real implementation from a GenerateTextFn.
// A reviewer must never throw and never block a flow: any failure means
// "no revisions".
// =============================================================================

const logger = log.scope("flow-review");

/** A media step that just completed inside the current modality batch. */
export interface ReviewedStep {
  stepId: string;
  capability: CapabilityId;
  prompt?: string;
  outputPath?: string;
}

/** A pending step whose prompt the reviewer may revise. */
export interface UpcomingStep {
  stepId: string;
  capability: CapabilityId;
  prompt?: string;
}

export interface FlowReviewCheckpoint {
  goal: string;
  /** The contiguous run of same-capability media steps that just finished. */
  completedBatch: ReviewedStep[];
  /** Not-yet-executed steps that carry a revisable string prompt. */
  upcoming: UpcomingStep[];
}

export interface FlowReviewVerdict {
  /** stepId -> replacement prompt, applied to upcoming steps only. */
  promptRevisions?: Record<string, string>;
}

export type FlowReviewer = (
  checkpoint: FlowReviewCheckpoint,
) => Promise<FlowReviewVerdict | null>;

let reviewer: FlowReviewer | null = null;

export function setFlowReviewer(fn: FlowReviewer | null): void {
  reviewer = fn;
}

export function getFlowReviewer(): FlowReviewer | null {
  return reviewer;
}

function buildReviewSystemPrompt(): string {
  return `You are the quality reviewer inside OrianBuilder's media flow.
A batch of media assets was just generated for a larger goal. Decide whether
the prompts of the UPCOMING steps should be revised so the remaining assets
stay consistent with the goal and with what was already produced (subject,
style, palette, naming).

Rules:
- Output ONLY valid JSON. No prose, no markdown fences.
- Shape: {"revisions": {"<stepId>": "<full replacement prompt>"}}
- Only include a step when its prompt genuinely needs to change; if everything
  is fine, output {"revisions": {}}.
- Never invent step ids; only use the upcoming step ids you were given.
- A replacement prompt must be complete and self-contained, not a diff.`;
}

function buildReviewUserPrompt(cp: FlowReviewCheckpoint): string {
  const completed = cp.completedBatch
    .map(
      (s) =>
        `- ${s.stepId} (${s.capability}): prompt=${JSON.stringify(
          s.prompt ?? "",
        )} output=${s.outputPath ?? "none"}`,
    )
    .join("\n");
  const upcoming = cp.upcoming
    .map(
      (s) =>
        `- ${s.stepId} (${s.capability}): prompt=${JSON.stringify(s.prompt ?? "")}`,
    )
    .join("\n");
  return `Goal: ${cp.goal}

Just generated:
${completed}

Upcoming steps:
${upcoming}`;
}

function extractJson(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s;
}

/**
 * Parse a reviewer model reply into a verdict, keeping only revisions that
 * target known upcoming step ids with non-empty string prompts. Never throws.
 */
export function parseReviewVerdict(
  raw: string,
  upcomingIds: ReadonlySet<string>,
): FlowReviewVerdict | null {
  try {
    const parsed = JSON.parse(jsonrepair(extractJson(raw))) as {
      revisions?: Record<string, unknown>;
    };
    const revisions: Record<string, string> = {};
    for (const [stepId, prompt] of Object.entries(parsed.revisions ?? {})) {
      if (
        upcomingIds.has(stepId) &&
        typeof prompt === "string" &&
        prompt.trim().length > 0
      ) {
        revisions[stepId] = prompt.trim();
      }
    }
    return { promptRevisions: revisions };
  } catch (err) {
    logger.warn("review verdict parse failed; skipping revisions", err);
    return null;
  }
}

/**
 * Real reviewer backed by the user's selected model (text-only for now —
 * vision-based asset inspection is a later addition, the hook shape already
 * allows it). Never throws.
 */
export function createLlmFlowReviewer(generate: GenerateTextFn): FlowReviewer {
  return async (cp) => {
    if (cp.upcoming.length === 0) return null;
    try {
      const raw = await generate({
        system: buildReviewSystemPrompt(),
        prompt: buildReviewUserPrompt(cp),
      });
      return parseReviewVerdict(raw, new Set(cp.upcoming.map((s) => s.stepId)));
    } catch (err) {
      logger.warn("flow review LLM call failed; skipping revisions", err);
      return null;
    }
  };
}
