/**
 * Getting around the Stage.
 *
 * There is no nav rail any more, so none of these can click a link. They drive
 * the command palette instead, which is the real user path and resolves through
 * the same capability graph Marta plans against — a test that navigates this
 * way is exercising the thing users actually do.
 *
 * The method names are unchanged because 54 specs call them. `goToXTab` is a
 * lie about the mechanism now, but renaming it across the suite would be churn
 * that buys nothing.
 */

import { Page, expect } from "@playwright/test";

/** Surface ids, from `src/main/marta/graph/surfaces.ts`. */
const SURFACE = {
  settings: "app.settings",
  library: "build.library",
  projects: "build.projects",
  chat: "build.workspace",
  templates: "build.templates",
} as const;

export class Navigation {
  constructor(public page: Page) {}

  /**
   * Summon a surface by id through the palette.
   *
   * Matched on `data-surface-id` rather than visible text: one surface's
   * summary routinely contains another's title, so a name match is ambiguous.
   */
  async goToSurface(surfaceId: string) {
    await expect(this.page.locator("#stage")).toBeVisible({ timeout: 60000 });

    // The palette toggles, so an already-open one would be closed by this.
    const input = this.page.getByPlaceholder("Go to…");
    if (!(await input.isVisible().catch(() => false))) {
      await this.page.keyboard.press("Control+k");
      await expect(input).toBeVisible({ timeout: 30000 });
    }

    const item = this.page.locator(`[data-surface-id="${surfaceId}"]`);
    await expect(item).toBeVisible({ timeout: 30000 });
    await item.click();
    await expect(input).toBeHidden({ timeout: 30000 });
  }

  async goToSettingsTab() {
    await this.goToSurface(SURFACE.settings);
  }

  async goToLibraryTab() {
    await this.goToSurface(SURFACE.library);
  }

  async goToAppsTab() {
    await this.goToSurface(SURFACE.projects);
  }

  /**
   * The Stage's resting state — what "home" means now.
   *
   * Nothing to summon: it is the absence of a surface. Escape closes the
   * palette if a previous step left it open, then the composer is the thing to
   * wait for, since that is what the old landing page's command bar became.
   */
  async goToOrionTab() {
    await expect(this.page.locator("#stage")).toBeVisible({ timeout: 60000 });
    await this.page.keyboard.press("Escape");
    await expect(
      this.page.getByPlaceholder(/Ask Marta|not running/),
    ).toBeVisible({ timeout: 60000 });
  }

  async goToChatTab() {
    await this.goToSurface(SURFACE.chat);
  }

  async goToHubTab() {
    await this.goToSurface(SURFACE.templates);
  }

  async clickBackButton() {
    await this.page.getByRole("button", { name: "Back" }).click();
  }

  async selectTemplate(templateName: string) {
    await this.page.getByRole("img", { name: templateName }).click();
  }

  async goToHubAndSelectTemplate(templateName: "Next.js Template") {
    await this.goToHubTab();
    await this.selectTemplate(templateName);
    await this.goToAppsTab();
  }
}
