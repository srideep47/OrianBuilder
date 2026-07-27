import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import log from "electron-log";
import { readSettings, writeSettings } from "@/main/settings";

const execFileAsync = promisify(execFile);
const logger = log.scope("blender-locate");

/** Blender's Python API stabilised for our purposes in 3.x; 4.x is preferred. */
export const MIN_BLENDER_MAJOR = 3;
export const MIN_BLENDER_MINOR = 3;

export interface BlenderInstall {
  executable: string;
  version: string;
  major: number;
  minor: number;
  patch: number;
  source: "setting" | "path" | "known-location";
  supported: boolean;
}

/**
 * Blender installs into versioned directories on Windows and a single app bundle
 * on macOS, so the sweep has to glob for versions rather than check fixed paths.
 */
async function knownLocations(): Promise<string[]> {
  const home = os.homedir();
  const out: string[] = [];

  if (process.platform === "win32") {
    const roots = [
      process.env.ProgramFiles ?? "C:\\Program Files",
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      path.join(home, "AppData", "Local", "Programs"),
    ];
    for (const root of roots) {
      const base = path.join(root, "Blender Foundation");
      try {
        const versions = await fs.readdir(base);
        // Newest first so a 4.x install wins over a leftover 3.x.
        for (const v of versions.sort().reverse()) {
          out.push(path.join(base, v, "blender.exe"));
        }
      } catch {
        /* not installed under this root */
      }
      out.push(path.join(root, "Blender", "blender.exe"));
    }
    out.push(
      path.join(home, "scoop", "apps", "blender", "current", "blender.exe"),
    );
    return out;
  }

  if (process.platform === "darwin") {
    return [
      "/Applications/Blender.app/Contents/MacOS/Blender",
      path.join(
        home,
        "Applications",
        "Blender.app",
        "Contents",
        "MacOS",
        "Blender",
      ),
      "/opt/homebrew/bin/blender",
      "/usr/local/bin/blender",
    ];
  }

  return [
    "/usr/bin/blender",
    "/usr/local/bin/blender",
    "/snap/bin/blender",
    "/var/lib/flatpak/exports/bin/org.blender.Blender",
    path.join(home, ".local", "bin", "blender"),
  ];
}

export function parseBlenderVersion(raw: string): {
  version: string;
  major: number;
  minor: number;
  patch: number;
} | null {
  // `blender --version` prints `Blender 4.2.1` on the first line.
  const match = raw.match(/Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return {
    version: `Blender ${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ""}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

async function probe(
  executable: string,
  source: BlenderInstall["source"],
): Promise<BlenderInstall | null> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
      timeout: 30_000,
      windowsHide: true,
    });
    const parsed = parseBlenderVersion(stdout || stderr);
    if (!parsed) return null;
    const supported =
      parsed.major > MIN_BLENDER_MAJOR ||
      (parsed.major === MIN_BLENDER_MAJOR && parsed.minor >= MIN_BLENDER_MINOR);
    return { executable, source, supported, ...parsed };
  } catch {
    return null;
  }
}

let cached: BlenderInstall | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

/**
 * Finds Blender. Same resolution order as the Godot locator: explicit setting,
 * then `PATH`, then the conventional install locations.
 */
export async function locateBlender(
  options: { force?: boolean } = {},
): Promise<BlenderInstall | null> {
  if (!options.force && cached && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  const configured = (readSettings() as { blenderExecutablePath?: string })
    .blenderExecutablePath;
  if (configured) {
    const found = await probe(configured, "setting");
    if (found) {
      cached = found;
      cachedAt = Date.now();
      return found;
    }
    logger.warn(`Configured Blender at ${configured} is not usable.`);
  }

  for (const name of ["blender", "blender4", "Blender"]) {
    const found = await probe(name, "path");
    if (found?.supported) {
      cached = found;
      cachedAt = Date.now();
      return found;
    }
  }

  for (const candidate of await knownLocations()) {
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

export async function setBlenderExecutable(
  executable: string,
): Promise<BlenderInstall> {
  const found = await probe(executable, "setting");
  if (!found) {
    throw new Error(
      `${path.basename(executable)} did not respond to --version like a Blender build.`,
    );
  }
  writeSettings({ blenderExecutablePath: executable } as Record<
    string,
    unknown
  >);
  cached = found;
  cachedAt = Date.now();
  return found;
}

export function invalidateBlenderCache(): void {
  cached = null;
  cachedAt = 0;
}

export const BLENDER_DOWNLOAD_URL = "https://www.blender.org/download/";
