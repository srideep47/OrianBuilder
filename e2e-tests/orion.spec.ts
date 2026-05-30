import { expect } from "@playwright/test";
import { test } from "./helpers/test_helper";
import { Timeout } from "./helpers/constants";

const FULL_WORKFLOW_PROMPT =
  "Create a polished UI screen concept with a hero image and a 3D GLB game asset, fetch latest AI news, monitor https://example.com/news, and track price for https://example.com/item";
const COFFEE_VIDEO_BUILD_PROMPT =
  "Create a landing page for a coffee brand with a logo and a promo video";

test.setTimeout(180_000);

test("Orion command center is available from home and persists workflow sessions", async ({
  po,
}) => {
  await po.setUp();

  await expect(
    po.page.getByRole("heading", { name: "Orion Command" }),
  ).toBeVisible({
    timeout: Timeout.LONG,
  });
  await expect(
    po.page.getByRole("heading", { name: "Model Engine" }),
  ).toBeVisible();
  await expect(
    po.page.getByRole("heading", { name: "Workflows" }),
  ).toBeVisible();
  await expect(
    po.page.getByRole("heading", { name: "Sessions" }),
  ).toBeVisible();

  await po.page.getByRole("link", { name: "Orion" }).click();
  await expect(
    po.page.getByRole("heading", { name: "Orion Command" }),
  ).toBeVisible({ timeout: Timeout.MEDIUM });

  await po.page
    .getByPlaceholder(/Describe what to build or generate/i)
    .fill(FULL_WORKFLOW_PROMPT);
  await po.page
    .locator('button[title="Run command (Cmd/Ctrl + Enter)"]')
    .click();

  await expect(po.page.getByText("Orchestrating your command...")).toBeVisible({
    timeout: Timeout.SHORT,
  });
  await expect(po.page.getByText("design-1")).toBeVisible({
    timeout: Timeout.EXTRA_LONG,
  });
  await expect(po.page.getByText("image-1")).toBeVisible();
  await expect(po.page.getByText("3d-asset-1")).toBeVisible();
  await expect(po.page.getByText("news-1")).toBeVisible();
  await expect(po.page.getByText("website-track-1")).toBeVisible();
  await expect(po.page.getByText("price-track-1")).toBeVisible();
  await expect(po.page.getByText(/partial|completed/)).toBeVisible();

  await po.page.getByRole("link", { name: "Engine", exact: true }).click();
  await expect(
    po.page.getByText(/Inference|Engine|Model/i).first(),
  ).toBeVisible({ timeout: Timeout.MEDIUM });

  await po.page.getByRole("link", { name: "Orion" }).click();
  await expect(po.page.getByRole("heading", { name: "Sessions" })).toBeVisible({
    timeout: Timeout.MEDIUM,
  });
  await expect(
    po.page.getByText(FULL_WORKFLOW_PROMPT.slice(0, 77)).first(),
  ).toBeVisible({ timeout: Timeout.MEDIUM });

  await expect(
    po.page.getByRole("link", { name: "Gen Assets", exact: true }),
  ).toBeVisible();
  await expect(po.page.getByRole("link", { name: /3D Assets/ })).toBeVisible();
  await expect(
    po.page.getByRole("link", { name: "Design", exact: true }),
  ).toBeVisible();
  await expect(po.page.getByRole("link", { name: /News/ })).toBeVisible();
  await expect(
    po.page.getByRole("link", { name: "Watchdog", exact: true }),
  ).toBeVisible();

  const flowResult = await po.page.evaluate(async (text) => {
    return (window as any).electron.ipcRenderer.invoke("flow:run-command", {
      text,
    });
  }, COFFEE_VIDEO_BUILD_PROMPT);
  const steps = flowResult.steps as Array<{
    capability: string;
    status: string;
    error?: string;
    output: Record<string, unknown>;
  }>;
  const imageStep = steps.find((step) => step.capability === "generate_image");
  const videoStep = steps.find((step) => step.capability === "generate_video");
  const buildStep = steps.find((step) => step.capability === "build_app");

  expect(flowResult.status).toMatch(/partial|completed/);
  expect(imageStep?.status).toBe("success");
  expect(videoStep?.status).toBe("success");
  expect(buildStep?.status).toBe("success");
  expect(imageStep?.error ?? "").not.toContain("Cannot fit model");
  expect(videoStep?.error ?? "").not.toContain("Cannot fit model");
  expect(buildStep?.error ?? "").not.toContain("Skipped");
  expect(
    videoStep?.output.setupRequired === true ||
      typeof videoStep?.output.outputPath === "string",
  ).toBe(true);
});
