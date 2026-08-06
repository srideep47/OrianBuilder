import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import log from "electron-log";
import { readSettings, writeSettings } from "@/main/settings";

const execFileAsync = promisify(execFile);
const logger = log.scope("godot-locate");

/** Minimum engine we support. The AI bridge extension targets Godot 4.x. */
export const MIN_GODOT_MAJOR = 4;
export const MIN_GODOT_MINOR = 2;

export interface GodotInstall {
  /** Absolute path to the Godot executable. */
  executable: string;
  /** Full `--version` string, e.g. `4.7.1.stable.official.abcdef123`. */
  version: string;
  major: number;
  minor: number;
  patch: number;
  /** True when the binary is a `.NET`/mono build (matters for C# projects). */
  mono: boolean;
  /** Where we found it — surfaced in the UI so the user can tell which one runs. */
  source: "setting" | "path" | "known-location" | "managed";
  /** False when the version is below the supported floor. */
  supported: boolean;
}

/**
 * Directories Godot is conventionally installed into, per platform. Checked in
 * order; the first match that reports a supported version wins.
 *
 * Godot ships as a single self-contained executable with no installer on any
 * platform, so there is no registry key or package database to consult — a path
 * sweep plus `PATH` is genuinely the whole discovery surface.
 */
async function knownLocations(): Promise<string[]> {
  const home = os.homedir();
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    const candidates = [
      path.join(programFiles, "Godot", "Godot.exe"),
      path.join(programFiles, "Godot", "godot.exe"),
      path.join(localAppData, "Programs", "Godot", "Godot.exe"),
      path.join(home, "scoop", "apps", "godot", "current", "godot.exe"),
      path.join(home, "Godot", "Godot.exe"),
      path.join(home, "Downloads", "Godot.exe"),
    ];

    // The official Windows download is a versioned portable executable, often
    // extracted into a same-named directory (for example
    // Downloads/Godot_v4.7.1-stable_win64.exe/Godot_v4.7.1-...exe). A fixed
    // Downloads/Godot.exe probe misses the normal install path entirely.
    const downloads = path.join(home, "Downloads");
    try {
      const entries = await fs.readdir(downloads, { withFileTypes: true });
      for (const entry of entries) {
        if (!/^godot.*(?:\.exe)?$/i.test(entry.name)) continue;
        const candidate = path.join(downloads, entry.name);
        if (entry.isFile() && /\.exe$/i.test(entry.name)) {
          if (!/console/i.test(entry.name)) candidates.push(candidate);
          continue;
        }
        if (!entry.isDirectory()) continue;
        const nested = await fs.readdir(candidate, { withFileTypes: true });
        for (const child of nested) {
          if (
            child.isFile() &&
            /^godot.*\.exe$/i.test(child.name) &&
            !/console/i.test(child.name)
          ) {
            candidates.push(path.join(candidate, child.name));
          }
        }
      }
    } catch {
      /* Downloads is absent or unreadable. The fixed probes still apply. */
    }
    return candidates;
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Godot.app/Contents/MacOS/Godot",
      path.join(
        home,
        "Applications",
        "Godot.app",
        "Contents",
        "MacOS",
        "Godot",
      ),
      "/opt/homebrew/bin/godot",
      "/usr/local/bin/godot",
    ];
  }
  return [
    "/usr/bin/godot",
    "/usr/local/bin/godot",
    "/var/lib/flatpak/exports/bin/org.godotengine.Godot",
    path.join(home, ".local", "bin", "godot"),
    path.join(
      home,
      ".local",
      "share",
      "flatpak",
      "exports",
      "bin",
      "org.godotengine.Godot",
    ),
  ];
}

/** Executable names to try on `PATH`. */
const PATH_CANDIDATES = [
  "godot",
  "godot4",
  "Godot",
  "godot-mono",
  "godot4-mono",
];

/**
 * Parses `Godot Engine v4.7.1.stable.official [abcdef123]` or the terser
 * `4.7.1.stable.official.abcdef123` that `--version` prints. Returns null when
 * the output doesn't look like a Godot version at all, which is how we reject a
 * `godot` on PATH that turns out to be something else entirely.
 */
export function parseGodotVersion(raw: string): {
  version: string;
  major: number;
  minor: number;
  patch: number;
  mono: boolean;
} | null {
  const text = raw.trim();
  const match = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return {
    version: text.split(/\r?\n/)[0] ?? text,
    major,
    minor,
    patch,
    mono: /mono|dotnet|\.net/i.test(text),
  };
}

async function probe(
  executable: string,
  source: GodotInstall["source"],
): Promise<GodotInstall | null> {
  try {
    // `--version` is the only flag that works without a project and without
    // opening a window; `--headless --version` also spins up servers on some
    // builds, so keep it bare.
    const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
      timeout: 15_000,
      windowsHide: true,
    });
    const parsed = parseGodotVersion(stdout || stderr);
    if (!parsed) return null;
    const supported =
      parsed.major > MIN_GODOT_MAJOR ||
      (parsed.major === MIN_GODOT_MAJOR && parsed.minor >= MIN_GODOT_MINOR);
    return { executable, source, supported, ...parsed };
  } catch {
    return null;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

let cached: GodotInstall | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

/**
 * Finds the Godot engine to drive.
 *
 * Resolution order, most explicit first:
 *  1. `settings.godotExecutablePath` — the user pointed at a specific build.
 *  2. `PATH` — a package-manager or manual install that's already on PATH.
 *  3. The conventional install directories for this platform.
 *
 * Result is cached for a minute so the Engine screen polling status doesn't
 * shell out to `--version` on every render.
 */
export async function locateGodot(
  options: { force?: boolean } = {},
): Promise<GodotInstall | null> {
  if (!options.force && cached && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  const configured = (readSettings() as { godotExecutablePath?: string })
    .godotExecutablePath;
  if (configured && (await fileExists(configured))) {
    const found = await probe(configured, "setting");
    if (found) {
      cached = found;
      cachedAt = Date.now();
      return found;
    }
    logger.warn(
      `Configured Godot at ${configured} did not report a usable version; falling back to discovery.`,
    );
  }

  for (const name of PATH_CANDIDATES) {
    const found = await probe(name, "path");
    if (found?.supported) {
      cached = found;
      cachedAt = Date.now();
      return found;
    }
  }

  for (const candidate of await knownLocations()) {
    if (!(await fileExists(candidate))) continue;
    const found = await probe(candidate, "known-location");
    if (found) {
      cached = found;
      cachedAt = Date.now();
      return found;
    }
  }

  cached = null;
  cachedAt = Date.now();
  return null;
}

/** Records an explicit engine path chosen by the user and re-probes it. */
export async function setGodotExecutable(
  executable: string,
): Promise<GodotInstall | null> {
  if (!(await fileExists(executable))) {
    throw new Error(`No file at ${executable}`);
  }
  const found = await probe(executable, "setting");
  if (!found) {
    throw new Error(
      `${path.basename(executable)} did not respond to --version like a Godot build.`,
    );
  }
  writeSettings({ godotExecutablePath: executable } as Record<string, unknown>);
  cached = found;
  cachedAt = Date.now();
  return found;
}

/** Drops the discovery cache. Called after an install or a settings change. */
export function invalidateGodotCache(): void {
  cached = null;
  cachedAt = 0;
}

/** The official download page, surfaced when no engine is found. */
export const GODOT_DOWNLOAD_URL = "https://godotengine.org/download";
export const GODOT_SOURCE_URL = "https://github.com/godotengine/godot";
