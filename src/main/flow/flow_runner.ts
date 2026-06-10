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
  /**
   * Maximum dependency-independent steps to run concurrently. Default 1 keeps
   * the proven sequential order (and per-modality review batches). Values >1
   * pay off when steps are dispatched to different peers; local model use is
   * still serialized by the lease manager / single-residency gate.
   */
  maxParallel?: number;
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

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, queue.length)) },
    async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
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
  const maxParallel = Math.max(1, options.maxParallel ?? 1);
  logger.info(
    `flow ${flowId} ${seededResults.size > 0 ? "resuming" : "starting"}: ` +
      `"${intent.goal}" (${intent.steps.length} steps, ${seededResults.size} already done` +
      `${maxParallel > 1 ? `, maxParallel=${maxParallel}` : ""})`,
  );

  // Clone steps so review-checkpoint prompt revisions never mutate the caller's
  // intent (the original prompts stay in the persisted record for inspection).
  const steps: FlowStep[] = intent.steps.map((s) => ({
    ...s,
    input: { ...s.input },
  }));
  const stepIds = new Set(steps.map((s) => s.id));

  const { appPath, mediaDir } = await resolveMediaContext(intent.appId);
  const priorOutputs: Record<string, Record<string, unknown>> = {};
  const resultsById = new Map<string, StepResult>();
  const nonSuccessfulStepIds = new Set<string>();

  for (const [id, seeded] of seededResults) {
    resultsById.set(id, seeded);
    priorOutputs[id] = seeded.output;
  }

  const orderedResults = () =>
    steps
      .filter((s) => resultsById.has(s.id))
      .map((s) => resultsById.get(s.id)!);

  const persist = (status: "running" | FlowRunStatus) =>
    saveFlowRunSafe({
      flowId,
      intent,
      status,
      startedAt,
      updatedAt: Date.now(),
      steps: orderedResults(),
    });

  const recordSkip = (step: FlowStep, reason: string) => {
    nonSuccessfulStepIds.add(step.id);
    resultsById.set(step.id, {
      stepId: step.id,
      capability: step.capability,
      status: "skipped",
      output: {},
      error: reason,
      durationMs: 0,
    });
    logger.warn(`flow ${flowId} skip step ${step.id}: ${reason}`);
  };

  /** Execute one step; returns its output, or null when it failed. Swap events
   *  drained after the step are attributed to it (approximate when parallel). */
  const executeStep = async (
    step: FlowStep,
  ): Promise<Record<string, unknown> | null> => {
    const stepStarted = Date.now();
    const ctx: FlowContext = {
      goal: intent.goal,
      appId: intent.appId,
      appPath,
      mediaDir,
      constraints: intent.constraints,
      priorOutputs,
      mediaProfile: options.mediaProfile,
    };
    try {
      const capability = getCapability(step.capability);
      const output = await capability.execute(step.input, ctx);
      priorOutputs[step.id] = output;
      const swaps = getModelLeaseManager().drainSwapTelemetry();
      resultsById.set(step.id, {
        stepId: step.id,
        capability: step.capability,
        status: "success",
        output,
        durationMs: Date.now() - stepStarted,
        swaps: swaps.length > 0 ? swaps : undefined,
      });
      logger.info(`flow ${flowId} step ${step.id} ok`);
      return output;
    } catch (err) {
      nonSuccessfulStepIds.add(step.id);
      const message = err instanceof Error ? err.message : String(err);
      const swaps = getModelLeaseManager().drainSwapTelemetry();
      resultsById.set(step.id, {
        stepId: step.id,
        capability: step.capability,
        status: "failed",
        output: {},
        error: message,
        durationMs: Date.now() - stepStarted,
        swaps: swaps.length > 0 ? swaps : undefined,
      });
      logger.error(`flow ${flowId} step ${step.id} failed: ${message}`);
      return null;
    }
  };

  await persist("running");

  if (maxParallel <= 1) {
    // ── Sequential path: original order, per-modality review batches ────────
    /** Contiguous same-capability media steps since the last checkpoint. */
    let batch: Array<{ step: FlowStep; output: Record<string, unknown> }> = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (seededResults.has(step.id)) continue;

      const unmetDep = (step.dependsOn ?? []).find((d) =>
        nonSuccessfulStepIds.has(d),
      );
      if (unmetDep) {
        recordSkip(step, `Skipped: dependency "${unmetDep}" did not succeed`);
        await persist("running");
        continue;
      }

      // Drain stale swap events so this step only reports its own swaps.
      getModelLeaseManager().drainSwapTelemetry();
      const output = await executeStep(step);
      await persist("running");

      // Modality-batch tracking + review checkpoint at the batch boundary.
      if (output !== null && MEDIA_CAPABILITIES.has(step.capability)) {
        batch.push({ step, output });
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
      } else if (output === null) {
        // A failed step ends the current batch without a review.
        batch = [];
      }
    }
  } else {
    // ── Parallel path: dependency waves, bounded concurrency ────────────────
    const succeeded = new Set<string>(seededResults.keys());
    // A dependency is satisfiable only by a successful step; references to
    // unknown step ids are ignored (matching the sequential path's behavior).
    const depSatisfied = (d: string) => succeeded.has(d) || !stepIds.has(d);
    let pending = steps.filter((s) => !seededResults.has(s.id));

    while (pending.length > 0) {
      // Propagate failures: skip anything depending on a non-successful step.
      const skipped = new Set<string>();
      for (const step of pending) {
        const unmetDep = (step.dependsOn ?? []).find((d) =>
          nonSuccessfulStepIds.has(d),
        );
        if (unmetDep) {
          recordSkip(step, `Skipped: dependency "${unmetDep}" did not succeed`);
          skipped.add(step.id);
        }
      }
      if (skipped.size > 0) {
        pending = pending.filter((s) => !skipped.has(s.id));
      }
      if (pending.length === 0) break;

      const ready = pending.filter((s) =>
        (s.dependsOn ?? []).every(depSatisfied),
      );
      if (ready.length === 0) {
        for (const step of pending) {
          recordSkip(step, "Skipped: unresolvable dependencies");
        }
        break;
      }

      getModelLeaseManager().drainSwapTelemetry();
      const waveBatch: Array<{
        step: FlowStep;
        output: Record<string, unknown>;
      }> = [];
      await runPool(ready, maxParallel, async (step) => {
        const output = await executeStep(step);
        if (output !== null && MEDIA_CAPABILITIES.has(step.capability)) {
          waveBatch.push({ step, output });
        }
      });

      const readyIds = new Set(ready.map((s) => s.id));
      pending = pending.filter((s) => !readyIds.has(s.id));
      for (const step of ready) {
        if (resultsById.get(step.id)?.status === "success") {
          succeeded.add(step.id);
        }
      }
      await persist("running");

      // One review checkpoint per wave: the wave's media output is the batch.
      await runReviewCheckpoint(flowId, intent.goal, waveBatch, pending);
    }
  }

  const stepResults = orderedResults();
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
