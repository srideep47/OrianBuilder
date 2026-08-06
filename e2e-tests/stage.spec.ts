/**
 * The Stage: one screen, no navigation chrome, everything summonable.
 *
 * Deliberately does not use `po.setUp()` — that helper provisions a test LLM
 * provider and then navigates the old shell, which no longer exists. These
 * assertions are about the shell itself, so they wait on the app rather than on
 * a page.
 */

import { expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { test, testWithConfig } from "./helpers/test_helper";
import { Timeout } from "./helpers/constants";

async function ready(po: { page: any }): Promise<void> {
  await po.page.waitForFunction(
    () => Boolean((window as any).electron?.ipcRenderer?.invoke),
    undefined,
    { timeout: Timeout.LONG },
  );
  // The Stage renders as soon as the root layout mounts.
  await po.page.waitForSelector("#stage", { timeout: Timeout.LONG });
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

test.describe.configure({ timeout: Timeout.LONG });

const testWithPendingChoice = testWithConfig({
  preLaunchHook: async ({ userDataDir }) => {
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.writeFile(
      path.join(userDataDir, "marta-memory.json"),
      JSON.stringify({
        version: 1,
        preferences: {
          codingWorker: "ask",
          localModel: null,
          claudeModel: null,
          claudeEffort: null,
        },
        history: [],
        pendingDelegation: {
          requestId: "e2e-choice",
          appId: 125,
          goal: "Add an accessible color legend",
          readOnly: false,
        },
      }),
      "utf8",
    );
  },
});

const testWithTaskDeck = testWithConfig({
  preLaunchHook: async ({ userDataDir }) => {
    await fs.mkdir(userDataDir, { recursive: true });
    const now = Date.now();
    const makeTask = (
      id: string,
      title: string,
      workerLabel: string,
      model: string,
      createdAt: number,
    ) => ({
      id,
      kind: "flow",
      title,
      goal: title,
      workerLabel,
      model,
      effort: "low",
      status: "running",
      phase: "Writing source",
      activeTool: "write_file",
      activeFile: "src/App.tsx",
      terminalTail: ["vite ready in 281ms"],
      testSummary: "12 passing",
      previewUrl: "http://localhost:5173",
      completedSteps: 3,
      inputTokens: 120,
      outputTokens: 340,
      createdAt,
      updatedAt: now,
    });
    await fs.writeFile(
      path.join(userDataDir, "marta-tasks.json"),
      JSON.stringify([
        makeTask(
          "flow:claude-one",
          "Build the landing page",
          "Claude Code",
          "claude-haiku-4-5",
          now - 15_000,
        ),
        makeTask(
          "flow:claude-two",
          "Verify responsive navigation",
          "Claude Code",
          "claude-haiku-4-5",
          now - 10_000,
        ),
        makeTask(
          "flow:local-one",
          "Generate product copy",
          "Orion local agent",
          "Qwen3.5-4B",
          now - 5_000,
        ),
      ]),
      "utf8",
    );
  },
});

test("boots to one screen with no navigation chrome", async ({ po }) => {
  await ready(po);

  // The whole point of P3: the rail, the context panel and the view switcher
  // are gone, and nothing replaced them.
  await expect(po.page.locator("#stage")).toBeVisible();
  await expect(po.page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
  await expect(po.page.getByRole("tablist", { name: "Views" })).toHaveCount(0);

  // The old shell's landing page is gone too — its command bar, quick-start
  // grid and sessions rail are all replaced by the composer.
  await expect(
    po.page.getByRole("heading", { name: "Orion Workspace" }),
  ).toHaveCount(0);
  await expect(po.page.getByTestId("orion-command-input")).toHaveCount(0);
});

test("resting state invites a request instead of showing a menu", async ({
  po,
}) => {
  await ready(po);
  await expect(po.page.getByText("Ask for anything.")).toBeVisible();
  await expect(po.page.getByPlaceholder(/Ask Marta|not running/)).toBeVisible();

  // The resting Stage is not a flat black shell: its translucent frame is
  // deliberately set over the lightweight CSS backdrop that mirrors Android.
  await expect
    .poll(() =>
      po.page
        .locator(".cosmos")
        .evaluate((node) => getComputedStyle(node).display),
    )
    .toBe("block");
  await expect(po.page.locator(".orion-stage")).toHaveCSS(
    "background-image",
    /radial-gradient/,
  );
});

test("every graph surface is reachable through the palette", async ({ po }) => {
  await ready(po);

  const graph = await invoke<{
    surfaces: Array<{ id: string; title: string }>;
  }>(po, "marta:get-graph");
  expect(graph.surfaces.length).toBeGreaterThan(15);

  await po.page.keyboard.press("Control+k");
  const input = po.page.getByPlaceholder("Go to…");
  await expect(input).toBeVisible();

  // Not a spot check: if any surface were missing from the palette it would be
  // unreachable, since there is no other way to get to it. Matched by id — the
  // visible text is not unique, because one surface's summary routinely
  // contains another's title.
  for (const surface of graph.surfaces) {
    await expect(
      po.page.locator(`[data-surface-id="${surface.id}"]`),
      `${surface.id} ("${surface.title}") must be in the palette`,
    ).toHaveCount(1);
  }
});

test("the palette summons a surface onto the Stage", async ({ po }) => {
  await ready(po);

  await po.page.keyboard.press("Control+k");
  await po.page.getByPlaceholder("Go to…").fill("Inference cockpit");
  await po.page.locator('[data-surface-id="engine.cockpit"]').click();

  // The Stage drove the router, which is what keeps deep links and every
  // in-page `useNavigate` coherent with what is on screen.
  await expect
    .poll(() =>
      po.page.evaluate(() => window.location.hash + window.location.pathname),
    )
    .toContain("/inference");
  await expect(po.page.getByText("Ask for anything.")).toHaveCount(0);
});

test("the ambient rail stays hidden while nothing is running", async ({
  po,
}) => {
  await ready(po);
  // A rail that is always present becomes navigation whatever you intended.
  await expect(
    po.page.getByRole("complementary", { name: "Running work" }),
  ).toHaveCount(0);
});

testWithTaskDeck(
  "task surfaces tile, resize by natural language and never collide with Marta",
  async ({ po }) => {
    await ready(po);

    const deck = po.page.getByTestId("stage-task-deck");
    await expect(deck).toBeVisible();
    await expect(deck).toHaveAttribute("data-tile-count", "3");
    const taskSurfaces = deck.getByTestId("stage-task-surface");
    await expect(taskSurfaces).toHaveCount(3);

    // Every task surface exposes its operational context and direct workspace
    // instruments; this is deliberately one broad E2E rather than five small
    // Electron launches.
    const firstTask = taskSurfaces.first();
    await expect(firstTask.getByText("Active file")).toBeVisible();
    await expect(firstTask.getByText("src/App.tsx")).toBeVisible();
    await expect(firstTask.getByText("Current tool")).toBeVisible();
    await expect(firstTask.getByText("Elapsed")).toBeVisible();
    for (const name of ["Preview", "Files", /Terminal/, "Problems", /Tests/]) {
      await expect(firstTask.getByRole("button", { name })).toBeVisible();
    }

    const composer = po.page.getByPlaceholder(/Ask Marta|not running/);
    await composer.fill("make Claude task one larger");
    await composer.press("Enter");
    await expect(
      deck.locator('[data-task-id="flow:claude-one"]'),
    ).toHaveAttribute("data-emphasis", "large");
    await expect(
      deck.locator('[data-task-id="flow:claude-two"]'),
    ).toHaveAttribute("data-emphasis", "normal");

    await composer.fill("show GPU and PC stats");
    await composer.press("Enter");
    await expect(deck.getByText("GPU", { exact: true })).toBeVisible();
    await expect(deck.getByText("PC", { exact: true })).toBeVisible();

    if (process.env.STAGE_SHOTS_DIR) {
      await fs.mkdir(process.env.STAGE_SHOTS_DIR, { recursive: true });
      await po.page.screenshot({
        path: path.join(process.env.STAGE_SHOTS_DIR, "task-deck-desktop.png"),
        fullPage: true,
      });
    }

    // Presence is a docked sibling, not an overlay. The invariant must hold
    // at desktop and compact widths while the task deck reflows.
    const assertNoComposerOverlap = async () => {
      const stageBox = await po.page.locator("#stage").boundingBox();
      const deckBox = await deck.boundingBox();
      const composerBox = await composer.boundingBox();
      expect(stageBox).not.toBeNull();
      expect(deckBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect((stageBox?.y ?? 0) + (stageBox?.height ?? 0)).toBeLessThanOrEqual(
        (composerBox?.y ?? 0) + 1,
      );
      const horizontalSeparation =
        (stageBox?.x ?? 0) + (stageBox?.width ?? 0) <= (deckBox?.x ?? 0) + 1;
      const verticalSeparation =
        (stageBox?.y ?? 0) + (stageBox?.height ?? 0) <= (deckBox?.y ?? 0) + 1;
      expect(horizontalSeparation || verticalSeparation).toBe(true);
    };
    await assertNoComposerOverlap();
    await po.page.setViewportSize({ width: 900, height: 800 });
    await assertNoComposerOverlap();
    if (process.env.STAGE_SHOTS_DIR) {
      await po.page.screenshot({
        path: path.join(process.env.STAGE_SHOTS_DIR, "task-deck-compact.png"),
        fullPage: true,
      });
    }
  },
);

testWithPendingChoice(
  "a coding choice is conversational and survives a restart",
  async ({ po }) => {
    await ready(po);
    const prompt = po.page.getByLabel(
      "Waiting for a spoken or typed coding model choice",
    );
    await expect(prompt).toBeVisible();
    await expect(prompt.getByText("Voice or text")).toBeVisible();
    await expect(prompt.getByRole("combobox")).toHaveCount(0);
    await expect(prompt.getByRole("button")).toHaveCount(0);

    const composer = po.page.getByPlaceholder(/Tell Marta which model to use/);
    await composer.fill("What are my options?");
    await composer.press("Enter");
    await expect(po.page.getByText(/Claude options are/)).toBeVisible();
    await expect(prompt).toBeVisible();

    const persisted = await invoke<{
      pending: { requestId: string; conversation?: object } | null;
    }>(po, "marta:get-pending-delegation");
    expect(persisted.pending?.requestId).toBe("e2e-choice");
    expect(persisted.pending?.conversation).toEqual({});

    await po.page
      .getByPlaceholder(/Tell Marta which model to use/)
      .fill("Never mind");
    await po.page.keyboard.press("Enter");
    await expect(
      po.page.getByText("Okay. I won't start that coding task."),
    ).toBeVisible();
    await expect(prompt).toHaveCount(0);
    await expect
      .poll(() =>
        invoke<{ pending: unknown }>(po, "marta:get-pending-delegation"),
      )
      .toEqual({ pending: null });
  },
);
