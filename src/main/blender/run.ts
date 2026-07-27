import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import log from "electron-log";
import { locateBlender } from "./locate";
import {
  BLENDER_HARNESS_PY,
  RESULT_BEGIN,
  RESULT_END,
  type BlenderOp,
} from "./harness";

const execFileAsync = promisify(execFile);
const logger = log.scope("blender-run");

export interface BlenderResult {
  ok: boolean;
  error?: string;
  traceback?: string;
  /** Everything Blender printed. Kept because its errors only appear here. */
  log: string;
  [key: string]: unknown;
}

let harnessPath: string | null = null;

/**
 * Writes the harness to a temp file once per app run.
 *
 * Not shipped as a resource file because it has to stay in lockstep with
 * `harness.ts`, and a stale copy in `resources/` after a hot reload would be a
 * genuinely confusing failure — the harness would silently be the previous
 * version's.
 */
async function ensureHarness(): Promise<string> {
  if (harnessPath) {
    try {
      await fs.access(harnessPath);
      return harnessPath;
    } catch {
      harnessPath = null;
    }
  }
  const dir = path.join(os.tmpdir(), "orion-blender");
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, "orion_harness.py");
  await fs.writeFile(target, BLENDER_HARNESS_PY, "utf8");
  harnessPath = target;
  return target;
}

/** Pulls the JSON payload out of Blender's very chatty stdout. */
function parseResult(output: string): BlenderResult | null {
  const start = output.indexOf(RESULT_BEGIN);
  const end = output.indexOf(RESULT_END);
  if (start < 0 || end < 0 || end < start) return null;
  const json = output.slice(start + RESULT_BEGIN.length, end).trim();
  try {
    return JSON.parse(json) as BlenderResult;
  } catch {
    return null;
  }
}

/**
 * Runs one Blender operation.
 *
 * Always `--background`: Blender's UI would steal focus and can't be driven, and
 * every operation here is a file-in/file-out transform. `--factory-startup`
 * ignores the user's own preferences and add-ons, so a broken third-party add-on
 * in their profile can't fail our pipeline.
 */
export async function runBlender(
  request: { op: BlenderOp } & Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<BlenderResult> {
  const install = await locateBlender();
  if (!install) {
    return {
      ok: false,
      log: "",
      error:
        "Blender not found. Install Blender 3.3 or newer and point Orion at it on the Game page.",
    };
  }
  if (!install.supported) {
    return {
      ok: false,
      log: "",
      error: `${install.version} is older than the supported 3.3 floor.`,
    };
  }

  const harness = await ensureHarness();
  const requestDir = path.join(os.tmpdir(), "orion-blender");
  await fs.mkdir(requestDir, { recursive: true });
  const requestPath = path.join(
    requestDir,
    `req-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`,
  );
  await fs.writeFile(requestPath, JSON.stringify(request), "utf8");

  const args = [
    "--background",
    "--factory-startup",
    "--python-exit-code",
    "1",
    "--python",
    harness,
    "--",
    requestPath,
  ];

  logger.info(`Blender ${request.op}`);
  let output = "";
  try {
    const { stdout, stderr } = await execFileAsync(install.executable, args, {
      timeout: options.timeoutMs ?? 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    output = `${stdout}\n${stderr}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`;
    // Fall through: the harness may still have emitted a structured failure
    // before Blender exited non-zero, and that message is far more useful than
    // "Command failed with exit code 1".
  } finally {
    await fs.rm(requestPath, { force: true }).catch(() => undefined);
  }

  const parsed = parseResult(output);
  if (parsed) return { ...parsed, log: output.trim() };

  return {
    ok: false,
    log: output.trim(),
    error:
      "Blender produced no structured result. This usually means it crashed during import — check the log for the failing file.",
  };
}

/** Cheap capability probe used by the Game page's status readout. */
export async function blenderInfo(): Promise<BlenderResult> {
  return runBlender({ op: "info" }, { timeoutMs: 60_000 });
}
