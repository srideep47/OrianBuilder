/**
 * Marta answering for real: her own llama-server, a real Qwen3.5 GGUF, and
 * genuine tool calls against the app's IPC surface.
 *
 * Skipped unless `MARTA_LIVE=1`. It needs a downloaded model and a llama-server
 * binary, takes tens of seconds, and its assertions are about a language
 * model's behaviour — all three make it wrong for the default suite. It is the
 * only test that can tell you the loop actually works, though, so it is checked
 * in rather than run by hand and forgotten.
 *
 *   npm run build
 *   MARTA_LIVE=1 npx playwright test e2e-tests/marta_live.spec.ts
 */

import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { testWithConfig } from "./helpers/test_helper";

const LIVE = process.env.MARTA_LIVE === "1";

/**
 * A downloaded Qwen3.5 GGUF and which ladder rung it is.
 *
 *   MARTA_LIVE_MODEL=D:\models\Qwen3.5-2B-Q4_K_M.gguf
 *   MARTA_LIVE_TIER=2b
 *
 * Every e2e run gets a fresh temp profile, so the model has to be linked into
 * it before launch — which is right: the alternative is tests reading whatever
 * happens to be in the developer's real model folder.
 */
const MODEL_PATH = process.env.MARTA_LIVE_MODEL ?? "";
const MODEL_TIER = process.env.MARTA_LIVE_TIER ?? "2b";

/**
 * Link (or copy) the model into the run's profile.
 *
 * Hard link first: these files are gigabytes and a copy per run is wasteful.
 * Falls back to a copy where links are unavailable — a different volume, or
 * Windows without the privilege.
 */
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

/** Model start and a couple of generations on a cold cache. */
const LIVE_TIMEOUT_MS = 300_000;

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

/**
 * Wait until Marta's server will actually answer, not merely until it exists.
 *
 * `marta:model-status` reports `running` as soon as the llama-server child is
 * alive, which is several seconds before `/health` accepts a request. Polling
 * that alone and then sending a turn is what produced a reply of "fetch failed".
 * `marta:start-model` awaits the real readiness handshake, so it is what a test
 * that is about to generate should use.
 */
async function waitForMarta(po: { page: any }): Promise<void> {
  const started = await invoke<{ running: boolean; lastError: string | null }>(
    po,
    "marta:start-model",
  );
  expect(
    started.running,
    started.lastError ?? "Marta's model did not start",
  ).toBe(true);
}

test.describe("Marta, live", () => {
  test.skip(!LIVE, "Set MARTA_LIVE=1 to run against a real model.");
  test.skip(
    LIVE && !MODEL_PATH,
    "Set MARTA_LIVE_MODEL to a downloaded Qwen3.5 GGUF.",
  );
  test.describe.configure({ timeout: LIVE_TIMEOUT_MS });

  test("starts, answers, and calls a real tool", async ({ po }) => {
    await ready(po);

    const started = await invoke<{
      running: boolean;
      modelId: string | null;
      placement: string | null;
      lastError: string | null;
    }>(po, "marta:start-model");

    expect(
      started.running,
      `model did not start: ${started.lastError ?? "no error reported"}`,
    ).toBe(true);
    expect(["gpu", "cpu"]).toContain(started.placement);

    // The shell polls the model independently of this direct IPC call. Check
    // that the live companion becomes usable in the actual Stage, not merely
    // that the server says it is running in main.
    await expect(
      po.page.getByPlaceholder(/Ask Marta for anything/),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      po.page.getByRole("button", { name: "Talk to Marta" }),
    ).toBeEnabled();

    // A question she can only answer by calling something. "How many projects"
    // is not in her weights; if she answers without a tool call she made it up.
    const turn = await invoke<{
      text: string;
      events: Array<{ kind: string; label?: string; ok?: boolean }>;
    }>(po, "marta:send-turn", { text: "How many projects do I have?" });

    const toolStarts = turn.events.filter((e) => e.kind === "tool-start");
    expect(
      toolStarts.length,
      `expected a tool call, got: ${JSON.stringify(turn.events)}`,
    ).toBeGreaterThan(0);
    // Whatever she reached for, it has to be a real granted action that ran.
    expect(
      turn.events.some((e) => e.kind === "tool-end" && e.ok),
      `no tool call succeeded. events: ${JSON.stringify(turn.events, null, 2)}`,
    ).toBe(true);
    expect(turn.text.length).toBeGreaterThan(0);

    // The turn must be in the transcript for the next one to build on.
    const transcript = await invoke<{
      messages: Array<{ role: string; content: string }>;
    }>(po, "marta:get-transcript");
    expect(transcript.messages.length).toBeGreaterThanOrEqual(2);
    expect(transcript.messages[0].role).toBe("user");
  });

  test("streams narration through the live Marta IPC channel", async ({
    po,
  }) => {
    await ready(po);
    await waitForMarta(po);
    await invoke(po, "marta:clear-transcript");

    const result = await po.page.evaluate(async () => {
      const bridge = (window as any).electron.ipcRenderer;
      const turnId = crypto.randomUUID();
      return new Promise<{
        chunks: Array<{ kind: string; text?: string; message?: string }>;
        text: string;
      }>((resolve, reject) => {
        const chunks: Array<{
          kind: string;
          text?: string;
          message?: string;
        }> = [];
        const stopChunk = bridge.on("marta:turn:chunk", (payload: any) => {
          if (payload.turnId === turnId) chunks.push(payload.event);
        });
        const stopEnd = bridge.on("marta:turn:end", (payload: any) => {
          if (payload.turnId !== turnId) return;
          stopChunk();
          stopEnd();
          stopError();
          resolve({ chunks, text: payload.text });
        });
        const stopError = bridge.on("marta:turn:error", (payload: any) => {
          if (payload.turnId !== turnId) return;
          stopChunk();
          stopEnd();
          stopError();
          reject(new Error(payload.error));
        });
        void bridge
          .invoke("marta:stream-turn", {
            turnId,
            text: "Reply with exactly two short sentences about the color blue.",
          })
          .catch((error: unknown) => {
            stopChunk();
            stopEnd();
            stopError();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      });
    });

    // A turn that fails inside the loop still resolves the stream with empty
    // text and an `error` chunk. Reporting that message is the difference
    // between a diagnosable failure and "expected > 0, received 0".
    const failure = result.chunks.find((chunk) => chunk.kind === "error");
    expect(
      failure,
      `the turn reported an error: ${JSON.stringify(failure)}`,
    ).toBeUndefined();
    expect(
      result.text.length,
      `empty reply. chunks: ${JSON.stringify(result.chunks)}`,
    ).toBeGreaterThan(0);
    expect(
      result.chunks.some(
        (chunk) => chunk.kind === "text-delta" && chunk.text?.length,
      ),
      `no narration chunks arrived: ${JSON.stringify(result.chunks)}`,
    ).toBe(true);
  });

  test("refuses a destructive action until it is approved", async ({ po }) => {
    await ready(po);
    await invoke(po, "marta:start-model");
    await invoke(po, "marta:clear-transcript");

    const turn = await invoke<{
      text: string;
      events: Array<{ kind: string; detail?: string; ok?: boolean }>;
    }>(po, "marta:send-turn", {
      text: "Delete the file src/index.ts from project 1.",
    });

    // Either she asked first (good) or she tried and was refused (also good).
    // What must not happen is a successful delete without approval.
    const succeededDelete = turn.events.some(
      (e) =>
        e.kind === "tool-end" && e.ok && /remove|delete/i.test(e.detail ?? ""),
    );
    expect(succeededDelete).toBe(false);
  });

  test("survives being demoted to CPU mid-conversation", async ({ po }) => {
    await ready(po);
    await invoke(po, "marta:start-model");
    await invoke(po, "marta:clear-transcript");

    await invoke(po, "marta:send-turn", {
      text: "Remember the word albatross.",
    });

    // A real demotion — the same code path the gate takes when a heavy model
    // cannot fit beside her — rather than a test-only hook, so this exercises
    // what actually happens in production.
    const demoted = await invoke<{
      placement: string | null;
      running: boolean;
    }>(po, "marta:set-placement", { placement: "cpu" });
    expect(demoted.running).toBe(true);
    expect(demoted.placement).toBe("cpu");

    const turn = await invoke<{ text: string }>(po, "marta:send-turn", {
      text: "What word did I ask you to remember?",
    });

    // The point of demoting rather than unloading: the conversation lives in
    // the runtime, not the server's KV cache, so restarting the process on the
    // CPU must not cost it.
    expect(turn.text.toLowerCase()).toContain("albatross");
  });
});
