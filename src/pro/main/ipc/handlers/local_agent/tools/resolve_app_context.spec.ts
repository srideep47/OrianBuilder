import { describe, expect, it } from "vitest";

import {
  normalizeAppNameArg,
  resolveTargetAppPath,
} from "./resolve_app_context";
import type { AgentContext } from "./types";

function makeContext(input: {
  appPath?: string;
  referencedApps?: Array<[string, string]>;
}): AgentContext {
  // Only the fields touched by resolveTargetAppPath need to be real — the
  // rest of AgentContext can stay loosely typed for the test.
  return {
    appPath: input.appPath ?? "C:/orian/apps/current-app",
    referencedApps: new Map(input.referencedApps ?? []),
  } as unknown as AgentContext;
}

describe("normalizeAppNameArg", () => {
  it("returns undefined for missing / empty / whitespace values", () => {
    expect(normalizeAppNameArg(undefined)).toBeUndefined();
    expect(normalizeAppNameArg(null)).toBeUndefined();
    expect(normalizeAppNameArg("")).toBeUndefined();
    expect(normalizeAppNameArg("   ")).toBeUndefined();
  });

  it.each([
    "current-app",
    "Current-App",
    "current_app",
    "CURRENT",
    "this",
    "this-app",
    "self",
    "me",
    ".",
    "@current",
    "@self",
  ])('treats placeholder "%s" as current app (returns undefined)', (value) => {
    expect(normalizeAppNameArg(value)).toBeUndefined();
  });

  it("preserves real app names (case-sensitive after trim)", () => {
    expect(normalizeAppNameArg("  my-todo-app  ")).toBe("my-todo-app");
    expect(normalizeAppNameArg("Marketing-Site")).toBe("Marketing-Site");
  });
});

describe("resolveTargetAppPath", () => {
  it("returns current app path when app_name is omitted", () => {
    const ctx = makeContext({ appPath: "C:/orian/apps/current-app" });
    expect(resolveTargetAppPath(ctx, undefined)).toBe(
      "C:/orian/apps/current-app",
    );
  });

  it("returns current app path when the model hallucinates 'current-app'", () => {
    const ctx = makeContext({ appPath: "C:/orian/apps/current-app" });
    expect(resolveTargetAppPath(ctx, "current-app")).toBe(
      "C:/orian/apps/current-app",
    );
  });

  it("returns current app path for every placeholder alias", () => {
    const ctx = makeContext({ appPath: "C:/orian/apps/foo" });
    for (const alias of [
      "current",
      "this",
      "self",
      ".",
      "@current",
      "current_app",
    ]) {
      expect(resolveTargetAppPath(ctx, alias)).toBe("C:/orian/apps/foo");
    }
  });

  it("returns current app path when app_name matches the current app folder", () => {
    const ctx = makeContext({ appPath: "C:/orian/apps/EndToEndTest" });
    expect(resolveTargetAppPath(ctx, "EndToEndTest")).toBe(
      "C:/orian/apps/EndToEndTest",
    );
    expect(resolveTargetAppPath(ctx, "endtoendtest")).toBe(
      "C:/orian/apps/EndToEndTest",
    );
  });

  it("returns current app path when app_name matches the DB display name (model echoes project title)", () => {
    const ctx = {
      ...makeContext({ appPath: "C:/orian/apps/42" }),
      appName: "Dropdown App",
    } as ReturnType<typeof makeContext>;
    expect(resolveTargetAppPath(ctx, "Dropdown App")).toBe("C:/orian/apps/42");
    expect(resolveTargetAppPath(ctx, "dropdown app")).toBe("C:/orian/apps/42");
  });

  it("resolves real @app references via the map", () => {
    const ctx = makeContext({
      appPath: "C:/orian/apps/current-app",
      referencedApps: [["marketing-site", "C:/orian/apps/marketing-site"]],
    });
    expect(resolveTargetAppPath(ctx, "marketing-site")).toBe(
      "C:/orian/apps/marketing-site",
    );
    expect(resolveTargetAppPath(ctx, "Marketing-Site")).toBe(
      "C:/orian/apps/marketing-site",
    );
  });

  it("throws when a non-placeholder name is not in the referenced apps map", () => {
    const ctx = makeContext({
      appPath: "C:/orian/apps/current-app",
      referencedApps: [["marketing-site", "C:/orian/apps/marketing-site"]],
    });
    expect(() => resolveTargetAppPath(ctx, "billing-service")).toThrow(
      /Unknown app_name 'billing-service'/,
    );
  });
});
