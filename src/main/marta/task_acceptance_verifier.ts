import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { apps } from "@/db/schema";
import type {
  MartaCodingTaskAcceptanceDecision,
  MartaCodingTaskAcceptanceEvidence,
  MartaCodingTaskAcceptanceTarget,
  MartaCodingTaskCheckEvidence,
  MartaCodingTaskFileSnapshot,
} from "@/ipc/types/marta";
import {
  detectProjectStack,
  type ProjectStackDetection,
} from "@/ipc/utils/project_stack_detector";
import {
  PtyCommandExecutionError,
  runPtyCommand,
} from "@/ipc/utils/pty_command_runner";
import {
  getManagedRuntimeStatus,
  waitForManagedRuntimeReady,
} from "@/ipc/utils/runtime_readiness";
import { getOrianBuilderAppPath } from "@/paths/paths";

import {
  deriveCodingTaskAcceptanceTarget,
  evaluateCodingTaskAcceptance,
} from "./task_acceptance";
import { inspectLiveRoute, type VisualInspection } from "./visual_verifier";

const MAX_SNAPSHOT_FILES = 20_000;
const MAX_HASH_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const PREVIEW_TIMEOUT_MS = 45_000;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const ACTIVE_SOURCE_DIRECTORIES = [
  "src",
  "app",
  "pages",
  "components",
  "public",
  "renderer",
  "electron",
  "server",
  "api",
  "lib",
];

const ACTIVE_ROOT_FILES = [
  "index.html",
  "package.json",
  "main.ts",
  "main.tsx",
  "main.js",
  "main.jsx",
  "app.ts",
  "app.tsx",
  "app.js",
  "app.jsx",
  "server.ts",
  "server.js",
];

export interface PreparedCodingTaskAcceptance {
  target: MartaCodingTaskAcceptanceTarget;
  baseline: MartaCodingTaskFileSnapshot;
}

export interface VerifiedCodingTaskAcceptance {
  evidence: MartaCodingTaskAcceptanceEvidence;
  decision: MartaCodingTaskAcceptanceDecision;
}

interface HostCommandResult {
  ok: boolean;
  output: string;
}

interface ManagedPreviewResult {
  ready: boolean;
  previewUrl?: string | null;
  error?: string | null;
}

export interface CodingTaskVerifierDependencies {
  detectStack: (projectRoot: string) => Promise<ProjectStackDetection>;
  snapshotProject: (
    projectRoot: string,
  ) => Promise<MartaCodingTaskFileSnapshot>;
  runCommand: (
    command: string,
    projectRoot: string,
  ) => Promise<HostCommandResult>;
  ensurePreview: (appId: number) => Promise<ManagedPreviewResult>;
  /** Renders the served route and reads its DOM. See `visual_verifier.ts`. */
  inspectRoute: (input: {
    url: string;
    goal: string;
  }) => Promise<VisualInspection>;
  /** Injected so the install decision is testable without a real workspace. */
  fileExists: (absolutePath: string) => Promise<boolean>;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function digestBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Capture a bounded, content-aware snapshot without relying on Git. */
export async function snapshotCodingProject(
  projectRoot: string,
): Promise<MartaCodingTaskFileSnapshot> {
  const root = path.resolve(projectRoot);
  const files: MartaCodingTaskFileSnapshot["files"] = {};
  let count = 0;

  async function visit(directory: string): Promise<void> {
    if (count >= MAX_SNAPSHOT_FILES) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (count >= MAX_SNAPSHOT_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
          await visit(absolute);
        }
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const stat = await fs.stat(absolute);
        const relative = normalizeRelativePath(path.relative(root, absolute));
        const digest =
          stat.size <= MAX_HASH_BYTES
            ? digestBuffer(await fs.readFile(absolute))
            : digestBuffer(
                Buffer.from(`${stat.size}:${Math.trunc(stat.mtimeMs)}`),
              );
        files[relative] = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          digest,
        };
        count += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  await visit(root);
  return { capturedAt: Date.now(), files };
}

/** Return added, modified, and deleted paths observed by Orion. */
export function diffCodingProjectSnapshots(
  before: MartaCodingTaskFileSnapshot,
  after: MartaCodingTaskFileSnapshot,
): string[] {
  const paths = new Set([
    ...Object.keys(before.files),
    ...Object.keys(after.files),
  ]);
  return [...paths]
    .filter((file) => {
      const previous = before.files[file];
      const current = after.files[file];
      return !previous || !current || previous.digest !== current.digest;
    })
    .sort();
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function discoverAcceptanceTargetPaths(
  projectRoot: string,
): Promise<string[]> {
  const targetPaths: string[] = [];
  for (const relative of ACTIVE_SOURCE_DIRECTORIES) {
    if (await pathExists(path.join(projectRoot, relative))) {
      targetPaths.push(relative);
    }
  }
  for (const relative of ACTIVE_ROOT_FILES) {
    if (await pathExists(path.join(projectRoot, relative))) {
      targetPaths.push(relative);
    }
  }
  return targetPaths;
}

async function runHostCommand(
  command: string,
  projectRoot: string,
): Promise<HostCommandResult> {
  const executable =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : "/bin/sh";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", command]
      : ["-lc", command];
  try {
    const result = await runPtyCommand(executable, args, {
      cwd: projectRoot,
      displayCommand: command,
      timeoutMs: COMMAND_TIMEOUT_MS,
      env: {
        ...process.env,
        CI: "1",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    });
    return { ok: true, output: result.output };
  } catch (error) {
    if (error instanceof PtyCommandExecutionError) {
      return { ok: false, output: error.output || error.message };
    }
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

async function ensureManagedPreview(
  appId: number,
): Promise<ManagedPreviewResult> {
  const status = getManagedRuntimeStatus(appId);
  if (status.status === "stopped" || status.status === "failed") {
    // Imported lazily to keep task persistence independent from the action
    // graph during application startup and unit tests.
    const { callHandler } = await import("./invoke_action");
    const started = await callHandler(
      "run-app",
      { appId },
      { label: "Orion acceptance preview" },
    );
    if (!started.ok) {
      return { ready: false, error: started.error };
    }
  }
  const readiness = await waitForManagedRuntimeReady({
    appId,
    timeoutMs: PREVIEW_TIMEOUT_MS,
  });
  return {
    ready: readiness.ready,
    previewUrl: readiness.previewUrl,
    error: readiness.error,
  };
}

const DEFAULT_DEPENDENCIES: CodingTaskVerifierDependencies = {
  detectStack: detectProjectStack,
  snapshotProject: snapshotCodingProject,
  runCommand: runHostCommand,
  ensurePreview: ensureManagedPreview,
  inspectRoute: inspectLiveRoute,
  fileExists: pathExists,
};

/** Resolve an Orion app id to its trusted absolute workspace path. */
export async function resolveCodingTaskProjectRoot(
  appId: number,
): Promise<string> {
  const [row] = await db
    .select({ path: apps.path })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  if (!row) throw new Error(`No app with id ${appId}`);
  return getOrianBuilderAppPath(row.path);
}

/** Derive the host contract and capture its pre-worker baseline. */
export async function prepareCodingTaskAcceptance(
  input: {
    goal: string;
    projectRoot: string;
    readOnly?: boolean;
  },
  dependencies: Partial<CodingTaskVerifierDependencies> = {},
): Promise<PreparedCodingTaskAcceptance> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const [stack, baseline, targetPaths] = await Promise.all([
    deps.detectStack(input.projectRoot),
    deps.snapshotProject(input.projectRoot),
    discoverAcceptanceTargetPaths(input.projectRoot),
  ]);
  const target = deriveCodingTaskAcceptanceTarget({
    goal: input.goal,
    projectRoot: path.resolve(input.projectRoot),
    targetPaths,
    readOnly: input.readOnly,
  });

  if (!target.readOnly) {
    const checks = new Set(target.requiredChecks);
    if (!stack.commands.build) checks.delete("build");
    if (!stack.commands.build && stack.commands.typecheck) {
      checks.add("typecheck");
    }
    target.requiredChecks = [...checks];
  }

  return { target, baseline };
}

function commandForCheck(
  stack: ProjectStackDetection,
  check: "build" | "typecheck" | "test",
): string | null {
  return stack.commands[check];
}

function tail(value: string, length = 2_000): string {
  const trimmed = value.trim();
  return trimmed.length <= length ? trimmed : trimmed.slice(-length);
}

/**
 * Verify a worker's terminal report using only evidence observed by Orion.
 * No worker-provided changed-file list or command claim is trusted here.
 */
export async function verifyCodingTaskAcceptance(
  input: {
    target: MartaCodingTaskAcceptanceTarget;
    baseline: MartaCodingTaskFileSnapshot;
    workerReportedSuccess: boolean;
    appId?: number;
  },
  dependencies: Partial<CodingTaskVerifierDependencies> = {},
): Promise<VerifiedCodingTaskAcceptance> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const projectRoot = input.target.projectRoot;
  if (!projectRoot) {
    throw new Error("Coding-task acceptance has no trusted project root.");
  }

  const [current, stack] = await Promise.all([
    deps.snapshotProject(projectRoot),
    deps.detectStack(projectRoot),
  ]);
  const observedChangedFiles = diffCodingProjectSnapshots(
    input.baseline,
    current,
  );
  const checks: MartaCodingTaskCheckEvidence[] = [];
  /** Reused by the `visual` check so the preview is not started twice. */
  let previewUrl: string | null = null;

  /**
   * Install dependencies once, before anything that needs them.
   *
   * The plan's definition of done lists install *before* build for a reason: a
   * newly scaffolded project has a `package.json` and no `node_modules`, so
   * `vite build` fails with "Cannot find package 'vite'" no matter what the
   * worker did. That is a guaranteed false failure, and a gate that always fails
   * teaches the user to ignore it.
   *
   * Presence of `node_modules` is the trigger rather than "always install":
   * re-installing on every verification would add a minute to every task and
   * could change a lockfile the worker deliberately edited.
   */
  const needsInstall =
    !input.target.readOnly &&
    input.target.requiredChecks.some((check) =>
      ["build", "typecheck", "test"].includes(check),
    ) &&
    (await deps.fileExists(path.join(projectRoot, "package.json"))) &&
    !(await deps.fileExists(path.join(projectRoot, "node_modules")));
  if (needsInstall) {
    const command = stack.commands.install;
    const observedAt = Date.now();
    const result = command
      ? await deps.runCommand(command, projectRoot)
      : {
          ok: false,
          output:
            "No install command was detected for this project's package manager.",
        };
    if (!result.ok) {
      // Nothing downstream can succeed without dependencies. Reporting the real
      // cause once beats a cascade of "cannot find package" build failures that
      // all describe the same thing.
      checks.push({
        check: "build",
        status: "failed",
        source: "orion",
        ...(command ? { command } : {}),
        detail: `Dependencies are not installed, so the build could not run.\n${tail(result.output)}`,
        observedAt,
      });
      const evidence: MartaCodingTaskAcceptanceEvidence = {
        workerReportedSuccess: input.workerReportedSuccess,
        observedChangedFiles,
        checks,
      };
      return {
        evidence,
        decision: evaluateCodingTaskAcceptance(input.target, evidence),
      };
    }
  }

  for (const required of input.target.requiredChecks) {
    const observedAt = Date.now();
    if (
      required === "build" ||
      required === "typecheck" ||
      required === "test"
    ) {
      const command = commandForCheck(stack, required);
      if (!command) {
        checks.push({
          check: required,
          status: "failed",
          source: "orion",
          detail: `No ${required} command was detected in the project.`,
          observedAt,
        });
        continue;
      }
      const result = await deps.runCommand(command, projectRoot);
      checks.push({
        check: required,
        status: result.ok ? "passed" : "failed",
        source: "orion",
        command,
        detail: tail(result.output),
        observedAt,
      });
      continue;
    }

    if (required === "preview") {
      if (input.appId === undefined) {
        checks.push({
          check: "preview",
          status: "failed",
          source: "orion",
          detail:
            "No Orion app id was available for managed preview verification.",
          observedAt,
        });
        continue;
      }
      const preview = await deps.ensurePreview(input.appId);
      previewUrl = preview.previewUrl ?? null;
      checks.push({
        check: "preview",
        status: preview.ready ? "passed" : "failed",
        source: "orion",
        artifact: preview.previewUrl ?? undefined,
        detail: preview.error ?? undefined,
        observedAt,
      });
      continue;
    }

    // `visual` runs last by construction: `deriveCodingTaskAcceptanceTarget`
    // always adds `preview` alongside it, and a Set preserves insertion order,
    // so the preview URL is already known here.
    const url =
      previewUrl ??
      (input.appId !== undefined
        ? ((await deps.ensurePreview(input.appId)).previewUrl ?? null)
        : null);
    if (!url) {
      checks.push({
        check: "visual",
        status: "failed",
        source: "orion",
        detail:
          "There was no live preview URL to render, so the change could not be confirmed on screen.",
        observedAt,
      });
      continue;
    }
    const inspection = await deps.inspectRoute({
      url,
      goal: input.target.goal,
    });
    checks.push({
      check: "visual",
      status: inspection.ok ? "passed" : "failed",
      source: "orion",
      artifact: inspection.screenshotPath ?? url,
      detail: inspection.detail,
      observedAt,
    });
  }

  const evidence: MartaCodingTaskAcceptanceEvidence = {
    workerReportedSuccess: input.workerReportedSuccess,
    observedChangedFiles,
    checks,
  };
  return {
    evidence,
    decision: evaluateCodingTaskAcceptance(input.target, evidence),
  };
}
