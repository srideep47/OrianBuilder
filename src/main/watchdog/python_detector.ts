/**
 * Locate a usable Python interpreter for the Watchdog backend.
 *
 * The Watchdog backend is FastAPI + APScheduler and needs a Python ≥ 3.11
 * (the version constraint comes from the `from __future__ import annotations`
 * + PEP 604 union types throughout `backend/app/*.py`).
 *
 * Search order, first hit wins:
 *   1. Explicit `override` argument (user-supplied path from settings)
 *   2. WATCHDOG_PYTHON env var
 *   3. Windows: `py -3.13`, `py -3.12`, `py -3.11`, `py -3`, then PATH probes
 *   4. macOS/Linux: `python3.13`, `python3.12`, `python3.11`, `python3`, `python`
 *
 * For each candidate we run `<cmd> --version` and parse the output. Anything
 * older than 3.11 is rejected; the next candidate is tried.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import log from "electron-log";

const execFileAsync = promisify(execFile);
const logger = log.scope("watchdog-python");

export interface PythonInfo {
  /** Absolute path or PATH-resolvable command (e.g. "python3", or "C:\\Python313\\python.exe"). */
  command: string;
  /** Pre-resolved argv prefix when using the Windows `py` launcher.
   *  e.g. ["-3.12"] for `py -3.12`. Empty when invoking a python binary directly. */
  argPrefix: readonly string[];
  /** Parsed semver bits. */
  version: { major: number; minor: number; patch: number; raw: string };
}

const MIN_MAJOR = 3;
const MIN_MINOR = 11;

function parseVersion(
  stdout: string,
  stderr: string,
): PythonInfo["version"] | null {
  // `python --version` prints to stdout on 3.4+; older builds and the `py`
  // launcher print to stderr. Check both.
  const text = `${stdout}\n${stderr}`;
  const match = text.match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    raw: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

function meetsMinimum(v: PythonInfo["version"]): boolean {
  if (v.major !== MIN_MAJOR) return v.major > MIN_MAJOR;
  return v.minor >= MIN_MINOR;
}

async function probe(
  command: string,
  argPrefix: readonly string[],
): Promise<PythonInfo | null> {
  try {
    const { stdout, stderr } = await execFileAsync(
      command,
      [...argPrefix, "--version"],
      { timeout: 5_000, windowsHide: true },
    );
    const version = parseVersion(stdout, stderr);
    if (!version) {
      logger.debug(
        `Probe ${command} ${argPrefix.join(" ")}: unparseable version "${stdout.trim() || stderr.trim()}"`,
      );
      return null;
    }
    if (!meetsMinimum(version)) {
      logger.debug(
        `Probe ${command} ${argPrefix.join(" ")}: ${version.raw} < ${MIN_MAJOR}.${MIN_MINOR}`,
      );
      return null;
    }
    return { command, argPrefix, version };
  } catch (err) {
    logger.debug(`Probe ${command} ${argPrefix.join(" ")} failed:`, err);
    return null;
  }
}

function candidateList(): Array<{
  command: string;
  argPrefix: readonly string[];
}> {
  if (process.platform === "win32") {
    return [
      { command: "py", argPrefix: ["-3.13"] },
      { command: "py", argPrefix: ["-3.12"] },
      { command: "py", argPrefix: ["-3.11"] },
      { command: "py", argPrefix: ["-3"] },
      { command: "python3", argPrefix: [] },
      { command: "python", argPrefix: [] },
    ];
  }
  return [
    { command: "python3.13", argPrefix: [] },
    { command: "python3.12", argPrefix: [] },
    { command: "python3.11", argPrefix: [] },
    { command: "python3", argPrefix: [] },
    { command: "python", argPrefix: [] },
  ];
}

/**
 * Search the host for a Python ≥ 3.11 that can run the Watchdog backend.
 *
 * @param override When provided, the only candidate tried — useful for the UI
 *   where the user pasted an explicit path. Returns `null` if it fails to run
 *   or is too old; callers should surface that to the user instead of falling
 *   back, otherwise the override silently does nothing.
 */
export async function detectPython(
  override?: string,
): Promise<PythonInfo | null> {
  if (override) {
    if (!fs.existsSync(override)) {
      logger.warn(`Override Python path does not exist: ${override}`);
      return null;
    }
    return probe(override, []);
  }

  const envOverride = process.env.WATCHDOG_PYTHON;
  if (envOverride && fs.existsSync(envOverride)) {
    const found = await probe(envOverride, []);
    if (found) return found;
  }

  for (const cand of candidateList()) {
    const found = await probe(cand.command, cand.argPrefix);
    if (found) {
      logger.info(
        `Using Python ${found.version.raw}: ${found.command}${found.argPrefix.length ? " " + found.argPrefix.join(" ") : ""}`,
      );
      return found;
    }
  }
  logger.warn("No Python >= 3.11 found on host");
  return null;
}

/** Build an argv prefix that invokes the detected interpreter, e.g.
 *  ["py", "-3.12", "-m", "venv", ...]. Use this when calling Python via
 *  child_process.spawn so the Windows `py` launcher is respected. */
export function pythonArgv(
  info: PythonInfo,
  rest: readonly string[],
): { file: string; args: string[] } {
  return { file: info.command, args: [...info.argPrefix, ...rest] };
}
