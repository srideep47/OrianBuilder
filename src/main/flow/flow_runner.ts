import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import log from "electron-log";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getOrianBuilderAppPath, getUserDataPath } from "@/paths/paths";
import { ORIANBUILDER_MEDIA_DIR_NAME } from "@/ipc/utils/media_path_utils";
import { getCapability, type FlowContext } from "./capability_registry";
import { getFlowReviewer } from "./flow_review";
import { getModelLeaseManager } from "./model_lease";
import { saveFlowRunSafe, loadFlowRun } from "./flow_run_store";
import type { HardwareModelProfile } from "./model_profiles";
import type {
  CommandIntent,
  FlowRunResult,
  FlowStep,
  StepResult,
  FlowRunStatus,
  CapabilityId,
} from "@/ipc/types/intent";

/** Optional run-time wiring for a flow (e.g. the resolved media model profile). */
export interface RunFlowOptions {
  /** Selected models + best per-stage settings; threaded to media capabilities. */
  mediaProfile?: HardwareModelProfile;
}

const logger = log.scope("flow-runner");

/** Capabilities whose contiguous runs form a "modality batch" for review. */
const MEDIA_CAPABILITIES: ReadonlySet<CapabilityId> = new Set([
  "generate_image",
  "generate_audio",
  "generate_music",
  "generate_video",
  "generate_3d_asset",
]);

/** Resolve the absolute media dir + app path for a flow. */
async function resolveMediaContext(
  appId?: number,
): Promise<{ appPath?: string; mediaDir: string }> {
  if (appId != null) {
    const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
    if (app) {
      const appPath = getOrianBuilderAppPath(app.path);
      const mediaDir = path.join(appPath, ORIANBUILDER_MEDIA_DIR_NAME);
      await fs.mkdir(mediaDir, { recursive: true });
      return { appPath, mediaDir };
    }
    logger.warn(`appId ${appId} not found; using scratch media dir`);
  }
  const mediaDir = path.join(getUserDataPath(), "orion-flow", "media");
  await fs.mkdir(mediaDir, { recursive: true });
  return { mediaDir };
}

function aggregateStatus(steps: StepResult[]): FlowRunStatus {
  if (steps.length === 0) return "completed";
  const successes = steps.filter((s) => s.status === "success").length;
  const setupRequired = steps.some((s) => s.output.setupRequired === true);
  if (successes === steps.length && setupRequired) return "partial";
  if (successes === steps.length) return "completed";
  if (successes === 0) return "failed";
  return "partial";
}

function swapTotals(
  steps: StepResult[],
): { count: number; totalMs: number } | undefined {
  let count = 0;
  let totalMs = 0;
  for (const step of steps) {
    for (const swap of step.swaps ?? []) {
      count += 1;
      totalMs += swap.durationMs;
    }
  }
  return count > 0 ? { count, totalMs } : undefined;
}

function promptOf(step: FlowStep): string | undefined {
  return typeof step.input.prompt === "string" ? step.input.prompt : undefined;
}

/**
 * Review checkpoint at a modality-batch boundary: hand the just-finished batch
 * and the still-pending prompted steps to the injected reviewer, and apply any
 * prompt revisions to the pending steps. Never throws and never fails the flow.
 */
async function runReviewCheckpoint(
  flowId: string,
  goal: string,
  batch: Array<{ step: FlowStep; output: Record<string, unknown> }>,
  pending: FlowStep[],
): Promise<void> {
  const reviewer = getFlowReviewer();
  if (!reviewer || batch.length === 0) return;

  const upcoming = pending
    .filter((s) => promptOf(s) !== undefined)
    .map((s) => ({
      stepId: s.id,
      capability: s.capability,
      prompt: promptOf(s),
    }));
  if (upcoming.length === 0) return;

  try {
    const verdict = await reviewer({
      goal,
      completedBatch: batch.map(({ step, output }) => ({
        stepId: step.id,
        capability: step.capability,
        prompt: promptOf(step),
        outputPath:
          typeof output.outputPath === "string" ? output.outputPath : undefined,
      })),
      upcoming,
    });

    const revisions = Object.entries(verdict?.promptRevisions ?? {});
    for (const [stepId, prompt] of revisions) {
      const target = pending.find((s) => s.id === stepId);
      if (!target) continue;
      logger.info(
        `flow ${flowId} review revised prompt of step ${stepId} (${target.capability})`,
      );
      target.input = { ...target.input, prompt };
    }
  } catch (err) {
    logger.warn(`flow ${flowId} review checkpoint failed; continuing`, err);
  }
}

/**
 * Core executor shared by fresh runs and resumes. `seededResults` carries the
 * successful step results of a previous attempt; those steps are not re-run,
 * their outputs are re-threaded into `priorOutputs` for dependents.
 */
async function executeFlow(
  flowId: string,
  intent: CommandIntent,
  options: RunFlowOptions,
  seededResults: Map<string, StepResult>,
  startedAt: number,
): Promise<FlowRunResult> {
  logger.info(
    `flow ${flowId} ${seededResults.size > 0 ? "resuming" : "starting"}: ` +
      `"${intent.goal}" (${intent.steps.length} steps, ${seededResults.size} already done)`,
  );

  // Clone steps so review-checkpoint prompt revisions never mutate the caller's
  // intent (the original prompts stay in the persisted record for inspection).
  const steps: FlowStep[] = intent.steps.map((s) => ({
    ...s,
    input: { ...s.input },
  }));

  const { appPath, mediaDir } = await resolveMediaContext(intent.appId);
  const priorOutputs: Record<string, Record<string, unknown>> = {};
  const stepResults: StepResult[] = [];
  const nonSuccessfulStepIds = new Set<string>();
  /** Contiguous same-capability media steps since the last checkpoint. */
  let batch: Array<{ step: FlowStep; output: Record<string, unknown> }> = [];

  const persist = (status: "running" | FlowRunStatus) =>
    saveFlowRunSafe({
      flowId,
      intent,
      status,
      startedAt,
      updatedAt: Date.now(),
      steps: stepResults,
    });

  await persist("running");

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Resume path: keep the previous successful result, re-thread its output.
    const seeded = seededResults.get(step.id);
    if (seeded) {
      priorOutputs[step.id] = seeded.output;
      stepResults.push(seeded);
      continue;
    }

    const stepStarted = Date.now();

    // Skip if a dependency did not succeed.
    const unmetDep = (step.dependsOn ?? []).find((d) =>
      nonSuccessfulStepIds.has(d),
    );
    if (unmetDep) {
      nonSuccessfulStepIds.add(step.id);
      stepResults.push({
        stepId: step.id,
        capability: step.capability,
        status: "skipped",
        output: {},
        error: `Skipped: dependency "${unmetDep}" did not succeed`,
        durationMs: 0,
      });
      logger.warn(`flow ${flowId} skip step ${step.id} (dep ${unmetDep})`);
      await persist("running");
      continue;
    }

    const ctx: FlowContext = {
      goal: intent.goal,
      appId: intent.appId,
      appPath,
      mediaDir,
      constraints: intent.constraints,
      priorOutputs,
      mediaProfile: options.mediaProfile,
    };

    // Drain stale swap events so this step only reports its own swaps.
    getModelLeaseManager().drainSwapTelemetry();

    let executedOutput: Record<string, unknown> | null = null;
    try {
      const capability = getCapability(step.capability);
      const output = await capability.execute(step.input, ctx);
      executedOutput = output;
      priorOutputs[step.id] = output;
      const swaps = getModelLeaseManager().drainSwapTelemetry();
      stepResults.push({
        stepId: step.id,
        capability: step.capability,
        status: "success",
        output,
        durationMs: Date.now() - stepStarted,
        swaps: swaps.length > 0 ? swaps : undefined,
      });
      logger.info(`flow ${flowId} step ${step.id} ok`);
    } catch (err) {
      nonSuccessfulStepIds.add(step.id);
      const message = err instanceof Error ? err.message : String(err);
      const swaps = getModelLeaseManager().drainSwapTelemetry();
      stepResults.push({
        stepId: step.id,
        capability: step.capability,
        status: "failed",
        output: {},
        error: message,
        durationMs: Date.now() - stepStarted,
        swaps: swaps.length > 0 ? swaps : undefined,
      });
      logger.error(`flow ${flowId} step ${step.id} failed: ${message}`);
    }
    await persist("running");

    // Modality-batch tracking + review checkpoint at the batch boundary.
    if (executedOutput !== null && MEDIA_CAPABILITIES.has(step.capability)) {
      batch.push({ step, output: executedOutput });
      const next = steps[i + 1];
      const atBoundary = !next || next.capability !== step.capability;
      if (atBoundary) {
        await runReviewCheckpoint(
          flowId,
          intent.goal,
          batch,
          steps.slice(i + 1).filter((s) => !seededResults.has(s.id)),
        );
        batch = [];
      }
    } else if (executedOutput === null) {
      // A failed step ends the current batch without a review.
      batch = [];
    }
  }

  const result: FlowRunResult = {
    flowId,
    goal: intent.goal,
    status: aggregateStatus(stepResults),
    steps: stepResults,
    startedAt,
    finishedAt: Date.now(),
    swapTotals: swapTotals(stepResults),
  };
  await persist(result.status);
  if (result.swapTotals) {
    logger.info(
      `flow ${flowId} swap cost: ${result.swapTotals.count} swap(s), ` +
        `${result.swapTotals.totalMs} ms total`,
    );
  }
  logger.info(`flow ${flowId} done: ${result.status}`);
  return result;
}

/**
 * Execute a parsed CommandIntent step by step. Media steps run through the
 * capability registry; the build step escalates to the Mission System. Steps
 * whose dependencies failed or were skipped are themselves skipped. Run state
 * is persisted after every step so an interrupted flow can be resumed.
 */
export async function runFlow(
  intent: CommandIntent,
  options: RunFlowOptions = {},
): Promise<FlowRunResult> {
  return executeFlow(
    crypto.randomUUID(),
    intent,
    options,
    new Map(),
    Date.now(),
  );
}

/**
 * Resume a persisted flow run: previously successful steps keep their results
 * (outputs re-threaded to dependents); failed, skipped, and unstarted steps
 * execute again under the same flow id.
 */
export async function resumeFlow(
  flowId: string,
  options: RunFlowOptions = {},
): Promise<FlowRunResult> {
  const saved = await loadFlowRun(flowId);
  if (!saved) {
    throw new Error(`No persisted flow run found for id "${flowId}".`);
  }
  if (saved.status === "completed") {
    throw new Error(
      `Flow run "${flowId}" already completed; nothing to resume.`,
    );
  }
  const seeded = new Map(
    saved.steps
      .filter((s) => s.status === "success")
      .map((s) => [s.stepId, s] as const),
  );
  return executeFlow(flowId, saved.intent, options, seeded, saved.startedAt);
}
