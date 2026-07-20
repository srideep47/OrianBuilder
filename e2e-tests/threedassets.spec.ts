import { expect } from "@playwright/test";
import { test } from "./helpers/test_helper";

test("opens the 3D Assets route without a renderer error", async ({
  electronApp,
}) => {
  const page = await electronApp.firstWindow();
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  await page.evaluate(() => {
    window.history.pushState({}, "", "/3dassets");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await expect(page.getByRole("heading", { name: "3D Assets" })).toBeVisible();
  await expect(
    page.getByText("Sorry, that shouldn't have happened!"),
  ).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
