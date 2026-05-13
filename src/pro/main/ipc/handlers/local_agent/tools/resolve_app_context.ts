import path from "node:path";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import type { AgentContext } from "./types";

/**
 * Placeholder values that models (especially Qwen 3.6, Llama 3.x, and other
 * thinking-mode models) frequently hallucinate when a tool parameter says
 * "omit to target the current app." Treat all of these as if `appName` were
 * not provided at all.
 *
 * Matching is case-insensitive and ignores surrounding whitespace.
 */
const CURRENT_APP_ALIASES: ReadonlySet<string> = new Set([
  "current-app",
  "current_app",
  "currentapp",
  "current",
  "this",
  "this-app",
  "this_app",
  "thisapp",
  "self",
  "me",
  "app",
  ".",
  "./",
  "@current",
  "@self",
  "@app",
  "@this",
  // Additional aliases for newly-created projects where the model echoes the
  // project's human-readable title back as app_name instead of omitting it.
  "the app",
  "the project",
  "project",
  "new app",
  "new project",
  "my app",
  "my project",
]);

/**
 * Normalize a model-supplied `app_name` argument. Returns `undefined` whenever
 * the value should be interpreted as "use the current app" — including the
 * common placeholder strings models hallucinate. Otherwise returns the
 * original (trimmed) name so the referenced-app lookup runs against a clean
 * key.
 */
export function normalizeAppNameArg(
  appName: string | null | undefined,
): string | undefined {
  if (appName === undefined || appName === null) {
    return undefined;
  }
  const trimmed = appName.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (CURRENT_APP_ALIASES.has(trimmed.toLowerCase())) {
    return undefined;
  }
  return trimmed;
}

function isCurrentAppPathName(ctx: AgentContext, appName: string): boolean {
  const lower = appName.toLowerCase();
  // Match against the directory basename (e.g. a numeric ID folder)
  if (path.basename(ctx.appPath).trim().toLowerCase() === lower) return true;
  // Match against the human-readable app display name stored in the DB
  if (ctx.appName && ctx.appName.trim().toLowerCase() === lower) return true;
  return false;
}

/**
 * Resolve the app path a read-only tool should target.
 *
 * - Omitted `appName` (or any placeholder alias like `"current-app"`,
 *   `"this"`, `"."`) → current app (`ctx.appPath`).
 * - Provided `appName` → must match a referenced app from the current turn's
 *   `@app:Name` mentions. Any other value is rejected.
 *
 * Write tools do not call this — they operate only on `ctx.appPath` so that
 * referenced apps remain structurally unreachable for modification.
 */
export function resolveTargetAppPath(
  ctx: AgentContext,
  appName: string | undefined,
): string {
  const normalized = normalizeAppNameArg(appName);
  if (!normalized) {
    return ctx.appPath;
  }
  if (isCurrentAppPathName(ctx, normalized)) {
    return ctx.appPath;
  }
  const appPath = ctx.referencedApps.get(normalized.toLowerCase());
  if (appPath) {
    return appPath;
  }
  const available = [...ctx.referencedApps.keys()];
  const availableStr =
    available.length > 0 ? available.join(", ") : "(none available)";
  throw new OrianBuilderError(
    `Unknown app_name '${appName}'. Available referenced apps: ${availableStr}. To target the current app, omit the app_name parameter entirely.`,
    OrianBuilderErrorKind.NotFound,
  );
}

/**
 * Glob pattern for `.orianbuilder/` internals, for use in the node `glob` library's
 * ignore list.
 *
 * A referenced app's `.orianbuilder/` folder (rules, chat history, snapshots, etc.) is
 * not part of the `@app:Name` reference contract and must not be exposed to
 * read-only tools when targeting another app.
 */
export const ORIANBUILDER_INTERNAL_GLOB = "**/.orianbuilder/**";

/**
 * Negated glob for ripgrep's `--glob` flag, excluding `.orianbuilder/` at the app root
 * (ripgrep globs are relative to cwd, which is the target app path).
 */
export const ORIANBUILDER_INTERNAL_RIPGREP_EXCLUDE = "!.orianbuilder/**";

/**
 * Is `relativePath` inside a `.orianbuilder/` folder at the app root?
 *
 * Accepts slashes in either direction and a leading `./`; callers should pass a
 * path already resolved relative to the app root (so traversal aliases like
 * `src/../.orianbuilder/...` normalize correctly before being checked).
 */
export function isOrianBuilderInternalPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.split("/")[0] === ".orianbuilder";
}

/**
 * Strip `.orianbuilder/` entries from a file list when targeting a referenced app.
 * No-op for the current app (`appName` omitted) — the user's own `.orianbuilder/`
 * internals are always visible to them.
 */
export function filterOrianBuilderInternalFiles<T extends { path: string }>(
  files: T[],
  appName: string | undefined,
): T[] {
  if (!normalizeAppNameArg(appName)) {
    return files;
  }
  return files.filter((file) => !isOrianBuilderInternalPath(file.path));
}

/**
 * Throw if a resolved path inside a referenced app points into its `.orianbuilder/`
 * folder. No-op when `appName` is omitted (current app). The relative path is
 * computed from the resolved `fullFilePath`, so normalized traversal aliases
 * (e.g. `src/../.orianbuilder/...`) are caught.
 */
export function assertOrianBuilderInternalAccessAllowed({
  targetAppPath,
  fullFilePath,
  appName,
}: {
  targetAppPath: string;
  fullFilePath: string;
  appName: string | undefined;
}): void {
  if (!normalizeAppNameArg(appName)) {
    return;
  }
  const relativeFromApp = path.relative(targetAppPath, fullFilePath);
  if (isOrianBuilderInternalPath(relativeFromApp)) {
    throw new OrianBuilderError(
      `Cannot read .orianbuilder/ paths from referenced apps — these files are not part of the @app reference contract.`,
      OrianBuilderErrorKind.Validation,
    );
  }
}
