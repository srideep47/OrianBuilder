/**
 * Verified completion, against real workers.
 *
 * This is the P5.3 exit demo as a test. The failure it exists to prevent is the
 * one that shipped: Claude created `rainbow-hello.html`, reported success, and
 * Orion agreed — because nothing checked the page the user was actually looking
 * at. Every assertion here is about *who decided* the work was done.
 *
 * Two live paths, both opt-in because they cost real usage and real minutes:
 *
 *   # Claude Code, Haiku at low effort, one tiny job
 *   npm run build
 *   MARTA_ACCEPTANCE_LIVE=1 npx playwright test e2e-tests/marta_acceptance_live.spec.ts
 *
 *   # The local agent, using Marta's own companion server
 *   MARTA_ACCEPTANCE_LIVE=1 MARTA_ACCEPTANCE_LOCAL=1 \
 *   MARTA_LIVE_MODEL="D:\OrianBuilderData\orianbuilder\models\marta\4b\Qwen3.5-4B-Q4_K_M.gguf" \
 *   MARTA_LIVE_TIER=4b \
 *   npx playwright test e2e-tests/marta_acceptance_live.spec.ts
 */

import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { testWithConfig } from "./helpers/test_helper";

const LIVE = process.env.MARTA_ACCEPTANCE_LIVE === "1";
const LOCAL = process.env.MARTA_ACCEPTANCE_LOCAL === "1";
const MODEL_PATH = process.env.MARTA_LIVE_MODEL ?? "";
const MODEL_TIER = process.env.MARTA_LIVE_TIER ?? "4b";

/** Small and cheap on purpose: Haiku at low effort, one job at a time. */
const CLAUDE_MODEL = process.env.MARTA_ACCEPTANCE_CLAUDE_MODEL ?? "haiku";
const CLAUDE_EFFORT = "low";

/**
 * The local coding worker, as `provider:name`.
 *
 * Required for the local path: `runLocalCodeTask` refuses to start without a
 * runnable model rather than silently picking one, so there is no default here
 * either — a test that quietly ran against a different model than the one you
 * meant would be worse than a skip.
 */
const LOCAL_MODEL = process.env.MARTA_ACCEPTANCE_LOCAL_MODEL ?? "";

/**
 * A worker turn, a build, a preview start and a rendered route.
 *
 * The local path gets longer: a 27B-class model on a 16 GB card does agentic
 * tool rounds at a fraction of a cloud worker's rate.
 */
const LIVE_TIMEOUT_MS = LOCAL ? 2_400_000 : 900_000;

/** The worker selection under test, identical in shape for both paths. */
function selection() {
  return LOCAL
    ? { worker: "local" as const, model: LOCAL_MODEL }
    : { worker: "claude" as const, model: CLAUDE_MODEL, effort: CLAUDE_EFFORT };
}

async function stageModel({ userDataDir }: { userDataDir: string }) {
  if (!MODEL_PATH) return;
  const dir = path.join(userDataDir, "models", "marta", MODEL_TIER);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(MODEL_PATH));
  try {
    fs.linkSync(MODEL_PATH, target);
  } catch {
    fs.copyFileSync(MODEL_PATH, target);
  }
}

const test = testWithConfig({ preLaunchHook: stageModel });

async function ready(po: { page: any }): Promise<void> {
  await po.page.waitForFunction(
    () => Boolean((window as any).electron?.ipcRenderer?.invoke),
    undefined,
    { timeout: 60_000 },
  );
}

async function invoke<T>(
  po: { page: any },
  channel: string,
  input?: unknown,
): Promise<T> {
  return po.page.evaluate(
    ([ch, arg]: [string, unknown]) =>
      (window as any).electron.ipcRenderer.invoke(ch, arg),
    [channel, input] as [string, unknown],
  );
}

interface LedgerTask {
  id: string;
  status: string;
  phase?: string;
  error?: string;
  acceptanceTarget?: {
    requiredChecks: string[];
    requireChangedFiles: boolean;
    projectRoot?: string;
  };
  acceptanceBaseline?: { capturedAt: number };
  acceptanceEvidence?: {
    workerReportedSuccess: boolean;
    observedChangedFiles: string[];
    checks: Array<{
      check: string;
      status: string;
      source: string;
      detail?: string;
    }>;
  };
  acceptanceDecision?: {
    accepted: boolean;
    status: string;
    relevantChangedFiles: string[];
    missingEvidence: string[];
    failedChecks: string[];
  };
}

async function getTask(po: { page: any }, taskId: string): Promise<LedgerTask> {
  const { tasks } = await invoke<{ tasks: LedgerTask[] }>(
    po,
    "marta:list-tasks",
    { includeCompleted: true, limit: 100 },
  );
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`task ${taskId} is not in the ledger`);
  return task;
}

async function waitForTerminal(
  po: { page: any },
  taskId: string,
): Promise<LedgerTask> {
  await expect
    .poll(
      async () => (await getTask(po, taskId)).status,
      // Polled slowly: each tick is an IPC round trip, and the interesting
      // transitions here take tens of seconds.
      { timeout: LIVE_TIMEOUT_MS - 60_000, intervals: [3_000] },
    )
    .toMatch(/^(succeeded|failed|cancelled)$/);
  return getTask(po, taskId);
}

async function createProject(
  po: { page: any },
  name: string,
): Promise<{ appId: number }> {
  const created = await invoke<{ app: { id: number } }>(po, "create-app", {
    name,
  });
  return { appId: created.app.id };
}

test.describe("verified completion, live", () => {
  test.skip(!LIVE, "Set MARTA_ACCEPTANCE_LIVE=1 to spend real worker time.");
  test.skip(
    LIVE && LOCAL && !LOCAL_MODEL,
    "Set MARTA_ACCEPTANCE_LOCAL_MODEL=provider:name for the local path.",
  );
  test.describe.configure({ timeout: LIVE_TIMEOUT_MS });

  test("a stated worker choice needs no second chooser", async ({ po }) => {
    await ready(po);
    const { appId } = await createProject(po, `marta-choice-${Date.now()}`);

    // The exact failure from the manual session: the worker, model and effort
    // are all in the first sentence, and Marta asked again anyway.
    const started = await invoke<{
      ok: boolean;
      summary: string;
      taskId?: string;
    }>(po, "marta:start-delegation", {
      requestId: crypto.randomUUID(),
      appId,
      goal: 'Change the homepage heading text to "Rainbow Hello".',
      readOnly: false,
      userReply: "Claude Haiku, low effort",
      selection: selection(),
    });

    expect(started.ok, `delegation refused to start: ${started.summary}`).toBe(
      true,
    );
    // A deterministic task id back from the delegation is what lets the Stage
    // and the narrator follow this work without guessing.
    expect(started.taskId, started.summary).toBeTruthy();

    const task = await getTask(po, started.taskId!);
    // The contract has to exist *before* the worker runs. Capturing a baseline
    // afterwards would compare the workspace against itself.
    expect(
      task.acceptanceTarget,
      "no acceptance contract was attached at dispatch",
    ).toBeTruthy();
    expect(task.acceptanceBaseline?.capturedAt ?? 0).toBeGreaterThan(0);
    expect(task.acceptanceTarget!.projectRoot).toBeTruthy();
    // A visible-text change is UI work, so it must be checked on screen.
    expect(task.acceptanceTarget!.requiredChecks).toContain("preview");
    expect(task.acceptanceTarget!.requiredChecks).toContain("visual");
  });

  test("completion is Orion's verdict, never the worker's", async ({ po }) => {
    await ready(po);
    const { appId } = await createProject(po, `marta-accept-${Date.now()}`);

    const started = await invoke<{
      ok: boolean;
      summary: string;
      taskId?: string;
    }>(po, "marta:start-delegation", {
      requestId: crypto.randomUUID(),
      appId,
      // Deliberately tiny. The subject of the test is the gate, not the model.
      goal: 'Add a visible heading with the exact text "Orion Verified" to the home page.',
      readOnly: false,
      selection: selection(),
    });
    expect(started.ok, started.summary).toBe(true);

    const task = await waitForTerminal(po, started.taskId!);
    // Printed, not asserted. A live worker may legitimately fail the gate, and
    // the useful output of this run is *why* — a pass with no visible verdict
    // would tell you the plumbing works and nothing about the work.
    console.log(
      `[acceptance] ${task.status} · ${task.phase ?? ""}\n` +
        `  decision: ${JSON.stringify(task.acceptanceDecision)}\n` +
        `  checks:   ${JSON.stringify(task.acceptanceEvidence?.checks)}\n` +
        `  changed:  ${JSON.stringify(task.acceptanceEvidence?.observedChangedFiles?.slice(0, 10))}\n` +
        `  error:    ${task.error ?? "none"}`,
    );

    // Whatever the outcome, a decision must exist. A task that reaches a
    // terminal state with no recorded decision is the old bug: the worker's word
    // became the result.
    expect(
      task.acceptanceDecision,
      `no acceptance decision was recorded. phase=${task.phase} error=${task.error}`,
    ).toBeTruthy();
    expect(task.acceptanceEvidence).toBeTruthy();

    // Every check Orion counted must be Orion's own observation.
    for (const check of task.acceptanceEvidence!.checks) {
      expect(
        check.source,
        `check ${check.check} was credited to ${check.source}`,
      ).toBe("orion");
    }

    // And the two states have to agree. `succeeded` with a rejected decision, or
    // `failed` with an accepted one, means the gate is decorative.
    if (task.status === "succeeded") {
      expect(task.acceptanceDecision!.accepted).toBe(true);
      expect(
        task.acceptanceEvidence!.observedChangedFiles.length,
      ).toBeGreaterThan(0);
      expect(
        task.acceptanceDecision!.relevantChangedFiles.length,
      ).toBeGreaterThan(0);
    } else {
      expect(task.acceptanceDecision!.accepted).toBe(false);
      // A rejection has to say why, or it is unactionable.
      expect(
        task.acceptanceDecision!.failedChecks.length +
          task.acceptanceDecision!.missingEvidence.length,
      ).toBeGreaterThan(0);
      expect(task.error).toBeTruthy();
    }
  });

  test("an orphan file outside the live app is not a success", async ({
    po,
  }) => {
    await ready(po);
    const { appId } = await createProject(po, `marta-orphan-${Date.now()}`);

    const started = await invoke<{
      ok: boolean;
      summary: string;
      taskId?: string;
    }>(po, "marta:start-delegation", {
      requestId: crypto.randomUUID(),
      appId,
      // This is the shape of the original failure, asked for explicitly: a
      // standalone file at the project root that the running app never imports.
      goal:
        "Create a single standalone file called rainbow-hello.html at the project root " +
        'containing an <h1> that says "Rainbow Hello". Do not modify any other file, ' +
        "and do not import it from the application.",
      readOnly: false,
      selection: selection(),
    });
    expect(started.ok, started.summary).toBe(true);

    const task = await waitForTerminal(po, started.taskId!);

    // The worker may well report success — it did exactly what it was told. The
    // point is that Orion must not.
    expect(
      task.acceptanceDecision?.accepted,
      `an orphan file was accepted. evidence=${JSON.stringify(task.acceptanceEvidence)}`,
    ).toBe(false);
    expect(task.status).toBe("failed");

    const rejection = [
      ...(task.acceptanceDecision?.failedChecks ?? []),
      ...(task.acceptanceDecision?.missingEvidence ?? []),
    ].join(", ");
    // Either the change was out of scope, or the page did not show it. Both are
    // correct reasons; a rejection with neither would be a coincidence.
    expect(rejection.length).toBeGreaterThan(0);
  });

  test("a real turn records measured inference telemetry", async ({ po }) => {
    test.skip(!LOCAL, "Needs Marta's own model; set MARTA_ACCEPTANCE_LOCAL=1.");
    await ready(po);

    const started = await invoke<{
      running: boolean;
      lastError: string | null;
    }>(po, "marta:start-model");
    expect(started.running, started.lastError ?? "model did not start").toBe(
      true,
    );

    const before = await invoke<{ samples: unknown[] }>(
      po,
      "telemetry:get-inference",
    );
    await invoke(po, "marta:send-turn", { text: "Say hello in one word." });
    const after = await invoke<{
      samples: Array<{
        actor: string;
        completionTokens: number;
        durationMs: number;
        contextSize: number | null;
      }>;
      lastTokensPerSecond: number | null;
      lastContextPercent: number | null;
    }>(po, "telemetry:get-inference");

    expect(after.samples.length).toBeGreaterThan(before.samples.length);
    const latest = after.samples.at(-1)!;
    expect(latest.actor).toBe("Marta companion");
    expect(latest.durationMs).toBeGreaterThan(0);
    // Measured, not derived from a constant: the whole point of the panel.
    expect(after.lastTokensPerSecond ?? 0).toBeGreaterThan(0);
    expect(latest.contextSize).toBe(65_536);
  });
});
