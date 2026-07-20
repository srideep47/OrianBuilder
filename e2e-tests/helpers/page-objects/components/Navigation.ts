/**
 * Page object for navigation between tabs and pages.
 * Handles tab navigation and back button.
 */

import { Page, expect } from "@playwright/test";

export class Navigation {
  constructor(public page: Page) {}

  async goToSettingsTab() {
    await this.page.getByRole("link", { name: "Settings" }).click();
  }

  async goToLibraryTab() {
    await this.page.getByRole("link", { name: "Library" }).click();
  }

  async goToAppsTab() {
    // The desktop information architecture now calls the former Apps area
    // "Projects". Keep this helper name for the large existing E2E suite while
    // driving the current navigation label.
    const projectsLink = this.page
      .getByRole("link", { name: "Projects" })
      .first();
    await expect(projectsLink).toBeVisible({ timeout: 60000 });
    await projectsLink.click();
    await expect(
      this.page.getByRole("heading", { name: "Apps" }),
    ).toBeVisible();
  }

  async goToOrionTab() {
    const orionLink = this.page.getByRole("link", { name: "Orion" });
    await expect(orionLink).toBeVisible({ timeout: 60000 });
    await orionLink.click();
    await expect(
      this.page.getByRole("heading", { name: "Orion Workspace" }),
    ).toBeVisible();
  }

  async goToChatTab() {
    await this.page.getByRole("link", { name: "Chat" }).click();
  }

  async goToHubTab() {
    await this.page.getByRole("link", { name: "Hub" }).click();
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
