import path from "node:path";
import fs from "node:fs/promises";
import log from "electron-log";
import { getUserDataPath } from "@/paths/paths";
import type {
  CommandIntent,
  StepResult,
  PersistedFlowStatus,
  ResumableFlowSummary,
} from "@/ipc/types/intent";
import type { FlowArtifact } from "@/ipc/types/manifest";

// =============================================================================
// Orion Flow — Run persistence (Phase 0 hardening)
// =============================================================================
//
// One JSON file per flow run under <userData>/orion-flow/runs/<flowId>.json,
// rewritten after every step. A run whose persisted status is still "running"
// means the app died mid-flow; together with "failed"/"partial" runs it can be
// resumed: successful step outputs are re-threaded and only the remaining
// steps execute again. Persistence is best-effort by design — a store failure
// must never fail the flow itself (callers wrap with saveFlowRunSafe).
// =============================================================================

const logger = log.scope("flow-run-store");

/** Everything needed to resume a run: the intent plus per-step results so far. */
export interface PersistedFlowRun {
  flowId: string;
  intent: CommandIntent;
  status: PersistedFlowStatus;
  startedAt: number;
  updatedAt: number;
  steps: StepResult[];
  /** Optional for backwards compatibility with P0-P4 run checkpoints. */
  artifacts?: FlowArtifact[];
}

/** Runs older than this are pruned regardless of status. */
const MAX_RUN_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Completed runs are pruned sooner — they exist only for inspection. */
const MAX_COMPLETED_AGE_MS = 24 * 60 * 60 * 1000;

function runsDir(): string {
  return path.join(getUserDataPath(), "orion-flow", "runs");
}

function runFile(flowId: string): string {
  // flowId is a UUID we generated; sanitize anyway so a corrupt id can't escape.
  return path.join(runsDir(), `${flowId.replace(/[^a-zA-Z0-9-]/g, "")}.json`);
}

export async function saveFlowRun(run: PersistedFlowRun): Promise<void> {
  const dir = runsDir();
  await fs.mkdir(dir, { recursive: true });
  const file = runFile(run.flowId);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(run), "utf-8");
  await fs.rename(tmp, file);
}

/** Persist without ever throwing — flow execution must not die on store I/O. */
export async function saveFlowRunSafe(run: PersistedFlowRun): Promise<void> {
  try {
    await saveFlowRun(run);
  } catch (err) {
    logger.warn(`failed to persist flow run ${run.flowId}`, err);
  }
}

export async function loadFlowRun(
  flowId: string,
): Promise<PersistedFlowRun | null> {
  try {
    const raw = await fs.readFile(runFile(flowId), "utf-8");
    return JSON.parse(raw) as PersistedFlowRun;
  } catch {
    return null;
  }
}

export async function deleteFlowRun(flowId: string): Promise<void> {
  await fs.rm(runFile(flowId), { force: true });
}

function toSummary(run: PersistedFlowRun): ResumableFlowSummary {
  return {
    flowId: run.flowId,
    goal: run.intent.goal,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    totalSteps: run.intent.steps.length,
    completedSteps: run.steps.filter((s) => s.status === "success").length,
  };
}

/**
 * List runs worth resuming (interrupted, failed, or partial), newest first.
 * Also prunes expired run files as a side effect (best-effort).
 */
export async function listResumableFlowRuns(): Promise<ResumableFlowSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(runsDir());
  } catch {
    return [];
  }

  const now = Date.now();
  const summaries: ResumableFlowSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const run = await loadFlowRun(entry.slice(0, -".json".length));
    if (!run || typeof run.updatedAt !== "number") continue;

    const age = now - run.updatedAt;
    const expired =
      age > MAX_RUN_AGE_MS ||
      (run.status === "completed" && age > MAX_COMPLETED_AGE_MS);
    if (expired) {
      await deleteFlowRun(run.flowId).catch(() => undefined);
      continue;
    }
    if (run.status !== "completed") summaries.push(toSummary(run));
  }

  return summaries.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
}
