/**
 * Screenshots of the Stage, for looking at rather than asserting on.
 *
 * Skipped unless `STAGE_SHOTS=1`: it produces artefacts, not verdicts, and a
 * test that always passes has no business in the default suite.
 */

import fs from "node:fs";
import path from "node:path";
import { test } from "./helpers/test_helper";
import { Timeout } from "./helpers/constants";

const SHOTS = process.env.STAGE_SHOTS === "1";
const OUT = process.env.STAGE_SHOTS_DIR ?? "test-results/stage-shots";

test.describe("Stage screenshots", () => {
  test.skip(!SHOTS, "Set STAGE_SHOTS=1 to capture.");
  test.describe.configure({ timeout: Timeout.LONG });

  test("capture", async ({ po }) => {
    fs.mkdirSync(OUT, { recursive: true });
    await po.page.waitForSelector("#stage", { timeout: Timeout.LONG });
    await po.page.waitForTimeout(1_500);

    await po.page.screenshot({ path: path.join(OUT, "01-resting.png") });

    await po.page.keyboard.press("Control+k");
    await po.page.waitForTimeout(400);
    await po.page.screenshot({ path: path.join(OUT, "02-palette.png") });

    await po.page.locator('[data-surface-id="engine.cockpit"]').click();
    await po.page.waitForTimeout(1_500);
    await po.page.screenshot({ path: path.join(OUT, "03-surface.png") });

    // A split: the second pane renders directly, outside the router.
    await po.page.keyboard.press("Control+k");
    await po.page.waitForTimeout(400);
    await po.page.locator('[data-surface-id="create.gallery"] button').click();
    await po.page.waitForTimeout(1_500);
    await po.page.screenshot({ path: path.join(OUT, "04-split.png") });
  });
});
