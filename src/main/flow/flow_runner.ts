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
import type { HardwareModelProfile } from "./model_profiles";
import type {
  CommandIntent,
  FlowRunResult,
  StepResult,
  FlowRunStatus,
} from "@/ipc/types/intent";

/** Optional run-time wiring for a flow (e.g. the resolved media model profile). */
export interface RunFlowOptions {
  /** Selected models + best per-stage settings; threaded to media capabilities. */
  mediaProfile?: HardwareModelProfile;
}

const logger = log.scope("flow-runner");

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

/**
 * Execute a parsed CommandIntent step by step. Media steps run through the
 * capability registry; the build step escalates to the Mission System. Steps
 * whose dependencies failed or were skipped are themselves skipped.
 */
export async function runFlow(
  intent: CommandIntent,
  options: RunFlowOptions = {},
): Promise<FlowRunResult> {
  const flowId = crypto.randomUUID();
  const startedAt = Date.now();
  logger.info(
    `flow ${flowId} starting: "${intent.goal}" (${intent.steps.length} steps)`,
  );

  const { appPath, mediaDir } = await resolveMediaContext(intent.appId);
  const priorOutputs: Record<string, Record<string, unknown>> = {};
  const stepResults: StepResult[] = [];
  const nonSuccessfulStepIds = new Set<string>();

  for (const step of intent.steps) {
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

    try {
      const capability = getCapability(step.capability);
      const output = await capability.execute(step.input, ctx);
      priorOutputs[step.id] = output;
      stepResults.push({
        stepId: step.id,
        capability: step.capability,
        status: "success",
        output,
        durationMs: Date.now() - stepStarted,
      });
      logger.info(`flow ${flowId} step ${step.id} ok`);
    } catch (err) {
      nonSuccessfulStepIds.add(step.id);
      const message = err instanceof Error ? err.message : String(err);
      stepResults.push({
        stepId: step.id,
        capability: step.capability,
        status: "failed",
        output: {},
        error: message,
        durationMs: Date.now() - stepStarted,
      });
      logger.error(`flow ${flowId} step ${step.id} failed: ${message}`);
    }
  }

  const result: FlowRunResult = {
    flowId,
    goal: intent.goal,
    status: aggregateStatus(stepResults),
    steps: stepResults,
    startedAt,
    finishedAt: Date.now(),
  };
  logger.info(`flow ${flowId} done: ${result.status}`);
  return result;
}
