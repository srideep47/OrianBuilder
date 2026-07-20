import { describe, expect, it } from "vitest";

import { normalizePackageManagerCommand } from "./package_manager_command";

describe("normalizePackageManagerCommand", () => {
  it("translates the failed Electron install to the pnpm project manager", () => {
    const result = normalizePackageManagerCommand(
      "npm install electron electron-builder concurrently wait-on cross-env --save-dev",
      "pnpm",
    );

    expect(result.command).toBe(
      "pnpm add electron electron-builder concurrently wait-on cross-env --save-dev",
    );
    expect(result.rewritten).toBe(true);
  });

  it("drops irrelevant npm cache recovery before switching to pnpm", () => {
    const result = normalizePackageManagerCommand(
      "npm cache clean --force && npm install electron --save-dev 2>&1",
      "pnpm",
    );

    expect(result.command).toBe("pnpm add electron --save-dev 2>&1");
  });

  it("uses install when no package names were supplied", () => {
    expect(
      normalizePackageManagerCommand("npm install --legacy-peer-deps", "pnpm")
        .command,
    ).toBe("pnpm install");
  });

  it("does not rewrite npm projects or npm run scripts", () => {
    expect(normalizePackageManagerCommand("npm install", "npm").rewritten).toBe(
      false,
    );
    expect(
      normalizePackageManagerCommand("npm run build", "pnpm").rewritten,
    ).toBe(false);
  });
});
