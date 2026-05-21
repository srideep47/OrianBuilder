/**
 * Watchdog backend installer.
 *
 * Creates a Python virtualenv under `<userData>/watchdog/.venv`, then installs
 * the FastAPI / cloudscraper / APScheduler dependencies from the vendored
 * `resources/watchdog/backend/requirements.txt`. Both phases stream their
 * stdout/stderr through an event listener so the renderer can show live
 * progress to the user.
 *
 * Idempotent: a `.setup-complete` marker is written on success. Re-running
 * `runFullSetup` after a successful install is a no-op unless `force` is set
 * — that way the page can call setup on every visit without re-downloading
 * packages.
 *
 * Layout:
 *   <userData>/watchdog/
 *   ├── .venv/                            ← virtualenv created here
 *   │   └── Scripts/python.exe            (Linux/macOS: bin/python)
 *   ├── .setup-complete                   ← marker file (contains install timestamp)
 *   └── watchdog.db                       ← runtime sqlite DB (created by backend)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import log from "electron-log";

import {
  detectPython,
  pythonArgv,
  type PythonInfo,
} from "./python_detector";

const logger = log.scope("watchdog-installer");

export type InstallPhase =
  | "detecting-python"
  | "creating-venv"
  | "installing-deps"
  | "ready"
  | "error";

export interface InstallEvent {
  phase: InstallPhase;
  /** Free-form line of pip/venv output. Streamed verbatim so the renderer can
   *  show a scrolling log. */
  line?: string;
  /** Populated only on phase="error" or phase="ready". */
  message?: string;
  /** Detected interpreter, only set once detection completes. */
  python?: { version: string; command: string };
}

export type InstallListener = (event: InstallEvent) => void;

const SETUP_MARKER_NAME = ".setup-complete";

export function getWatchdogRoot(): string {
  return path.join(app.getPath("userData"), "watchdog");
}

export function getVenvDir(): string {
  return path.join(getWatchdogRoot(), ".venv");
}

export function getVenvPython(): string {
  const venv = getVenvDir();
  return process.platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python");
}

export function getSetupMarkerPath(): string {
  return path.join(getWatchdogRoot(), SETUP_MARKER_NAME);
}

export function getDatabasePath(): string {
  return path.join(getWatchdogRoot(), "watchdog.db");
}

/**
 * Path to the vendored backend (the `backend/` directory containing `run.py`
 * and `app/`). When packaged, electron-builder copies `resources/watchdog/`
 * to `<resourcesPath>/watchdog/`; in dev we resolve relative to the project
 * root.
 */
export function getBundledBackendDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "watchdog", "backend");
  }
  // In dev with vite/electron-forge, app.getAppPath() points at the project
  // root (the directory containing package.json).
  return path.join(app.getAppPath(), "resources", "watchdog", "backend");
}

export function isSetupComplete(): boolean {
  try {
    return fs.existsSync(getSetupMarkerPath()) && fs.existsSync(getVenvPython());
  } catch {
    return false;
  }
}

function ensureRoot(): void {
  const root = getWatchdogRoot();
  fs.mkdirSync(root, { recursive: true });
}

/**
 * Run a child process, forwarding its stdout/stderr as `InstallEvent` lines.
 * Resolves with the exit code (or rejects on spawn error).
 */
function runStreaming(
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    phase: InstallPhase;
    onEvent: InstallListener;
  },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(file, args as string[], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const emit = (line: string) => {
      const trimmed = line.replace(/\r/g, "");
      if (!trimmed) return;
      options.onEvent({ phase: options.phase, line: trimmed });
    };
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\n/)) emit(line);
    });
    proc.stderr?.on("data", (chunk: string) => {
      // pip writes progress to stderr; surface it as ordinary log lines.
      for (const line of chunk.split(/\n/)) emit(line);
    });
    proc.once("error", (err) => reject(err));
    proc.once("exit", (code) => resolve(code ?? -1));
  });
}

async function createVenv(
  python: PythonInfo,
  onEvent: InstallListener,
): Promise<void> {
  const venvDir = getVenvDir();
  if (fs.existsSync(getVenvPython())) {
    onEvent({
      phase: "creating-venv",
      line: `Reusing existing virtualenv at ${venvDir}`,
    });
    return;
  }
  ensureRoot();
  onEvent({ phase: "creating-venv", line: `Creating virtualenv at ${venvDir}` });
  const { file, args } = pythonArgv(python, ["-m", "venv", venvDir]);
  const exitCode = await runStreaming(file, args, {
    phase: "creating-venv",
    onEvent,
  });
  if (exitCode !== 0) {
    throw new Error(
      `venv creation failed with exit code ${exitCode}. ` +
        `Try installing the python3-venv package (Linux) or reinstall Python with "tcl/tk and IDLE" disabled (Windows).`,
    );
  }
  if (!fs.existsSync(getVenvPython())) {
    throw new Error(
      `venv was created but the interpreter is missing at ${getVenvPython()}`,
    );
  }
}

async function installRequirements(onEvent: InstallListener): Promise<void> {
  const requirements = path.join(getBundledBackendDir(), "requirements.txt");
  if (!fs.existsSync(requirements)) {
    throw new Error(
      `Watchdog requirements.txt not found at ${requirements}. ` +
        `The packaged resources may be incomplete — try reinstalling the app.`,
    );
  }
  const venvPython = getVenvPython();
  onEvent({
    phase: "installing-deps",
    line: `Installing dependencies from ${requirements}`,
  });

  // Upgrade pip first — old pips occasionally fail to resolve cloudscraper's
  // sub-dependencies. This step is cheap and rarely fails.
  const upgradeCode = await runStreaming(
    venvPython,
    ["-m", "pip", "install", "--upgrade", "pip"],
    { phase: "installing-deps", onEvent },
  );
  if (upgradeCode !== 0) {
    // Non-fatal — continue with whatever pip is in the venv.
    onEvent({
      phase: "installing-deps",
      line: `pip upgrade exited ${upgradeCode}; continuing with bundled pip`,
    });
  }

  const installCode = await runStreaming(
    venvPython,
    ["-m", "pip", "install", "-r", requirements],
    { phase: "installing-deps", onEvent },
  );
  if (installCode !== 0) {
    throw new Error(
      `pip install failed with exit code ${installCode}. ` +
        `Check the log lines above for the failing package.`,
    );
  }
}

export interface SetupOptions {
  /** Explicit Python path from the user (settings or input field). */
  pythonOverride?: string | null;
  /** When true, re-run setup even if the marker exists. */
  force?: boolean;
  onEvent: InstallListener;
}

/**
 * Full first-time setup: detect Python, create the venv, install deps, write
 * the marker. Returns `{ ok: true }` on success or `{ ok: false, message }`
 * with a user-facing string on any failure. Never throws — the renderer
 * displays the message verbatim.
 */
export async function runFullSetup(
  options: SetupOptions,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { onEvent } = options;
  try {
    if (!options.force && isSetupComplete()) {
      onEvent({
        phase: "ready",
        message: "Watchdog is already set up.",
      });
      return { ok: true };
    }

    onEvent({ phase: "detecting-python" });
    const python = await detectPython(options.pythonOverride ?? undefined);
    if (!python) {
      const msg = options.pythonOverride
        ? `The Python at "${options.pythonOverride}" could not be used (missing, broken, or older than 3.11).`
        : "No Python 3.11+ found on this machine. Install Python from https://www.python.org/downloads/ and try again, or paste an explicit path to a python executable.";
      onEvent({ phase: "error", message: msg });
      return { ok: false, message: msg };
    }
    onEvent({
      phase: "detecting-python",
      python: { version: python.version.raw, command: python.command },
      line: `Found Python ${python.version.raw}`,
    });

    await createVenv(python, onEvent);
    await installRequirements(onEvent);

    fs.writeFileSync(
      getSetupMarkerPath(),
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          pythonVersion: python.version.raw,
        },
        null,
        2,
      ),
    );
    onEvent({ phase: "ready", message: "Setup complete" });
    logger.info(
      `Watchdog setup complete (python ${python.version.raw}, venv at ${getVenvDir()})`,
    );
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err ?? "unknown error");
    logger.error("Watchdog setup failed:", err);
    onEvent({ phase: "error", message });
    return { ok: false, message };
  }
}

/** Remove the venv + marker. Useful for a "Reset Watchdog" admin action.
 *  Leaves the database untouched. */
export function uninstall(): void {
  try {
    fs.rmSync(getVenvDir(), { recursive: true, force: true });
  } catch (err) {
    logger.warn("Failed to remove venv:", err);
  }
  try {
    fs.rmSync(getSetupMarkerPath(), { force: true });
  } catch (err) {
    logger.warn("Failed to remove setup marker:", err);
  }
}
