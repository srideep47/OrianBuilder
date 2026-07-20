import { expect } from "@playwright/test";
import { test } from "./helpers/test_helper";
import { Timeout } from "./helpers/constants";

test("Orion workspace exposes the unified natural-language surface", async ({
  po,
}) => {
  await po.setUp();

  await expect(
    po.page.getByRole("heading", { name: "Orion Workspace" }),
  ).toBeVisible({ timeout: Timeout.LONG });
  await expect(
    po.page.getByRole("heading", {
      name: "What should Orion finish for you?",
    }),
  ).toBeVisible();
  await expect(po.page.getByTestId("orion-command-input")).toBeVisible();
  await expect(
    po.page.getByRole("button", { name: "Run Orion command" }),
  ).toBeDisabled();

  for (const focus of ["Anything", "Software", "Media", "Design"]) {
    await expect(
      po.page.getByRole("button", { name: focus, exact: true }),
    ).toBeVisible();
  }
  await expect(
    po.page.getByRole("button", { name: "Autonomous", exact: true }),
  ).toBeVisible();
  await expect(
    po.page.getByRole("button", { name: "Ask me", exact: true }),
  ).toBeVisible();

  await expect(
    po.page.getByRole("link", { name: "Media", exact: true }),
  ).toBeVisible();
  await expect(
    po.page.getByRole("link", { name: "Projects" }).last(),
  ).toBeVisible();
  await expect(
    po.page.getByRole("heading", { name: "Sessions" }),
  ).toBeVisible();
});

test("Orion control center retains setup and advanced runtime controls", async ({
  po,
}) => {
  await po.setUp();

  await po.page.getByRole("button", { name: "More Orion tools" }).click();
  await po.page.getByRole("link", { name: "Control Center" }).click();

  await expect(
    po.page.getByRole("heading", { name: "Orion", exact: true }),
  ).toBeVisible({ timeout: Timeout.MEDIUM });
  await expect(
    po.page.getByRole("heading", { name: "Set up Orion" }),
  ).toBeVisible();
  await expect(po.page.getByText("Install media backend")).toBeVisible();
  await expect(po.page.getByText("Download media models")).toBeVisible();
  await expect(po.page.getByText("Start media backend")).toBeVisible();
  await expect(
    po.page.getByRole("heading", { name: "Model Engine" }),
  ).toBeVisible();
  await expect(
    po.page.getByRole("heading", { name: "Workflows" }),
  ).toBeVisible();
  await expect(
    po.page.getByRole("heading", { name: "How Orion works" }),
  ).toBeVisible();
});
