/**
 * Marta's control plane, exercised over the real IPC boundary.
 *
 * The unit tests prove the capability graph is *built* correctly. They cannot
 * prove it is *reachable*: the preload allowlist, the contract registration in
 * `ipc_host.ts`, and the Zod validation in `createTypedHandler` all sit between
 * the graph and anything that would use it, and all three are wired by hand.
 * A missing line in `channels.ts` would pass every unit test and fail every
 * real call.
 *
 * These run against the built app, so `npm run build` must be current.
 */

import { expect } from "@playwright/test";
import { test } from "./helpers/test_helper";
import { Timeout } from "./helpers/constants";

/**
 * Deliberately does NOT call `po.setUp()`.
 *
 * `setUp` provisions a test LLM provider and then navigates the UI, which
 * couples every spec that uses it to the current shell. These tests are about
 * the IPC control plane and need neither — and the shell is being replaced by
 * the Stage, so depending on it would guarantee churn. All they require is a
 * launched app with the preload bridge attached.
 */
async function ready(po: { page: any }): Promise<void> {
  await po.page.waitForFunction(
    () => Boolean((window as any).electron?.ipcRenderer?.invoke),
    undefined,
    { timeout: Timeout.LONG },
  );
}

/** Call an IPC channel the way the generated clients do. */
async function invoke<T>(
  po: { page: { evaluate: (fn: any, arg: any) => Promise<any> } },
  channel: string,
  input?: unknown,
): Promise<T> {
  return po.page.evaluate(
    ([ch, arg]: [string, unknown]) =>
      (window as any).electron.ipcRenderer.invoke(ch, arg),
    [channel, input] as [string, unknown],
  );
}

test("Marta's capability graph is reachable over IPC", async ({ po }) => {
  await ready(po);

  const graph = await invoke<{
    actions: Array<{
      id: string;
      channel: string;
      parameters: Record<string, unknown>;
      confirm: boolean;
      risk: string;
    }>;
    surfaces: Array<{ id: string; route: string }>;
    delegates: Array<{ id: string }>;
    unregistered: string[];
    orphaned: string[];
    totalContracts: number;
  }>(po, "marta:get-graph");

  // The registry is curated, so exact counts would be churn. What must hold is
  // the shape of the bargain: a real subset of a much larger surface.
  expect(graph.actions.length).toBeGreaterThan(50);
  expect(graph.totalContracts).toBeGreaterThan(400);
  expect(graph.unregistered.length).toBeGreaterThan(graph.actions.length);
  expect(graph.actions.length + graph.unregistered.length).toBe(
    graph.totalContracts,
  );

  // A stale registry entry would mean Marta is offered a capability the app
  // cannot perform. The unit tests assert this too; asserting it here catches
  // the case where the built bundle and the source have diverged.
  expect(graph.orphaned).toEqual([]);

  expect(graph.surfaces.length).toBeGreaterThan(15);
  expect(graph.delegates.length).toBeGreaterThan(0);

  // Every action must arrive with a tool-callable parameter schema. `z.void()`
  // inputs flatten to `{}`, which tool-calling APIs reject, so the
  // normalisation in `build_graph.ts` has to survive serialisation too.
  for (const action of graph.actions) {
    expect(action.parameters.type, `${action.id} parameters`).toBe("object");
    expect(action.channel.length).toBeGreaterThan(0);
  }
});

test("withheld contracts are absent from the graph", async ({ po }) => {
  await ready(po);

  const graph = await invoke<{ actions: Array<{ id: string }> }>(
    po,
    "marta:get-graph",
  );
  const granted = new Set(graph.actions.map((a) => a.id));

  // Default deny is the whole safety story. If it ever regresses, a
  // mis-transcribed sentence could wipe the user's projects.
  for (const withheld of [
    "system.resetAll",
    "system.clearSessionData",
    "app.deleteApp",
    "chat.deleteChat",
    "github.discardChanges",
  ]) {
    expect(granted.has(withheld), `${withheld} must stay withheld`).toBe(false);
  }
});

test("destructive actions arrive gated", async ({ po }) => {
  await ready(po);

  const graph = await invoke<{
    actions: Array<{ id: string; confirm: boolean }>;
  }>(po, "marta:get-graph");
  const byId = new Map(graph.actions.map((a) => [a.id, a]));

  expect(byId.get("workspaceFiles.remove")?.confirm).toBe(true);
  expect(byId.get("terminal.write")?.confirm).toBe(true);
  expect(byId.get("github.push")?.confirm).toBe(true);
  // Reading is never gated — gating it would make voice unusable.
  expect(byId.get("app.listApps")?.confirm).toBe(false);
});

test("retrieval answers in the words a person would use", async ({ po }) => {
  await ready(po);

  const result = await invoke<{ actions: Array<{ id: string }> }>(
    po,
    "marta:retrieve",
    { query: "commit my changes" },
  );
  const ids = result.actions.map((a) => a.id);

  expect(ids).toContain("git.commitChanges");
  // The pinned core is always offered, whatever was said.
  expect(ids).toContain("app.listApps");
});

test("the world-state digest renders and reflects the Stage", async ({
  po,
}) => {
  await ready(po);

  const before = await invoke<{
    state: { stage: { surfaceId: string | null } };
    rendered: string;
  }>(po, "marta:get-world-state");
  expect(before.state.stage.surfaceId).toBeNull();
  expect(before.rendered).toContain("the Stage is empty");

  // The renderer owns what is on screen and pushes it to main. This proves the
  // whole round trip: renderer → preload allowlist → handler → digest.
  await invoke(po, "marta:set-stage-state", {
    surfaceId: "create.studio",
    params: { appId: 7 },
  });

  const after = await invoke<{
    state: { stage: { surfaceId: string | null } };
    rendered: string;
  }>(po, "marta:get-world-state");
  expect(after.state.stage.surfaceId).toBe("create.studio");
  expect(after.rendered).toContain("On screen: create.studio");
});

test("residency reports a plan for whatever hardware this is", async ({
  po,
}) => {
  await ready(po);

  const residency = await invoke<{
    plan: {
      tierId: string;
      modelId: string;
      placement: string;
      speechNative: boolean;
      rationale: string;
    } | null;
    recentDemotions: number;
    thrashLatched: boolean;
    budgetMb: number | null;
  }>(po, "marta:get-residency");

  // Hardware differs between this desktop and CI, so the tier is not asserted —
  // only that a plan was produced at all, with a reason a human can read.
  expect(residency.plan).not.toBeNull();
  expect(["omni", "4b", "2b", "0.8b", "cpu-only"]).toContain(
    residency.plan!.tierId,
  );
  expect(["gpu", "cpu"]).toContain(residency.plan!.placement);
  expect(residency.plan!.rationale.length).toBeGreaterThan(0);

  // Nothing has run yet, so nothing should have migrated.
  expect(residency.recentDemotions).toBe(0);
  expect(residency.thrashLatched).toBe(false);
});

test("channels outside the preload allowlist are rejected", async ({ po }) => {
  await ready(po);

  const error = await po.page.evaluate(async () => {
    try {
      await (window as any).electron.ipcRenderer.invoke("marta:not-a-channel");
      return null;
    } catch (e: any) {
      return String(e?.message ?? e);
    }
  });

  expect(error).toContain("Invalid channel");
});

test("the active-turn cancellation control is reachable over IPC", async ({
  po,
}) => {
  await ready(po);

  // There is deliberately no active generation in this deterministic test.
  // The false result proves the new contract made the full route from renderer
  // through preload validation to the main-process handler without inventing a
  // cancellation; the runtime unit test covers aborting an actual request.
  const result = await invoke<{ cancelled: boolean }>(
    po,
    "marta:cancel-active-turn",
  );
  expect(result).toEqual({ cancelled: false });
});

test("live machine telemetry is sampled over IPC", async ({ po }) => {
  await ready(po);

  const sample = await invoke<{
    capturedAt: number;
    gpus: Array<{
      name: string;
      utilizationPercent: number | null;
      memoryTotalMb: number | null;
    }>;
    gpuUnavailableReason: string | null;
    cpu: { percent: number | null; cores: number };
    memory: { usedMb: number; totalMb: number; percent: number };
  }>(po, "telemetry:get-live-sample");

  expect(sample.capturedAt).toBeGreaterThan(0);
  // RAM is measured with `os`, so it is available on every machine and is the
  // honest assertion here. A GPU probe depends on `nvidia-smi` being installed.
  expect(sample.memory.totalMb).toBeGreaterThan(0);
  expect(sample.memory.percent).toBeGreaterThanOrEqual(0);
  expect(sample.memory.percent).toBeLessThanOrEqual(100);
  expect(sample.cpu.cores).toBeGreaterThan(0);

  // Either a GPU was sampled or the reason it was not is stated. Silence would
  // let a broken probe read as an idle card.
  expect(sample.gpus.length > 0 || sample.gpuUnavailableReason !== null).toBe(
    true,
  );
  for (const gpu of sample.gpus) {
    expect(gpu.name.length).toBeGreaterThan(0);
    expect(gpu.memoryTotalMb ?? 0).toBeGreaterThan(0);
  }

  // The second call proves the cache does not break the contract's shape.
  const again = await invoke<{ capturedAt: number }>(
    po,
    "telemetry:get-live-sample",
  );
  expect(again.capturedAt).toBeGreaterThan(0);
});

test("inference telemetry reports nothing rather than guessing", async ({
  po,
}) => {
  await ready(po);

  const telemetry = await invoke<{
    samples: unknown[];
    lastTokensPerSecond: number | null;
    averageTokensPerSecond: number | null;
  }>(po, "telemetry:get-inference");

  // No model call has happened in this deterministic run. A fabricated
  // throughput number would be indistinguishable from a real one.
  expect(Array.isArray(telemetry.samples)).toBe(true);
  if (telemetry.samples.length === 0) {
    expect(telemetry.lastTokensPerSecond).toBeNull();
    expect(telemetry.averageTokensPerSecond).toBeNull();
  }
});

test("task control refuses an unknown task instead of failing silently", async ({
  po,
}) => {
  await ready(po);

  const result = await invoke<{ ok: boolean; summary: string }>(
    po,
    "marta:control-task",
    { taskId: "claude:does-not-exist", action: "stop" },
  );

  // Reachability *and* honesty: the contract made it through preload validation
  // and the handler declined rather than reporting a stop that never happened.
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("ledger");
});

test("the proactive-narration channel is subscribable", async ({ po }) => {
  await ready(po);

  // Marta narrates real milestones without a user turn. If this channel is
  // missing from the preload receive allowlist the whole proactive-reporting
  // feature is silently dead, and no unit test can see that.
  const subscribed = await po.page.evaluate(() => {
    try {
      const off = (window as any).electron.ipcRenderer.on(
        "marta:proactive-narration",
        () => {},
      );
      if (typeof off === "function") off();
      return true;
    } catch {
      return false;
    }
  });

  expect(subscribed).toBe(true);
});

test.describe.configure({ timeout: Timeout.LONG });
