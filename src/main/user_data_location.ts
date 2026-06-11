import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("user-data-location");

/**
 * Relocating the Electron `userData` directory (which holds the SQLite DB,
 * settings, Chromium state and, critically, the multi-GB `mediaai` model
 * cache) cannot be configured from `user-settings.json`, because that file
 * lives *inside* userData (chicken-and-egg). Instead we persist the chosen
 * location in a tiny pointer file kept in a FIXED, never-relocated directory
 * (`app.getPath("appData")`, i.e. the parent of the default userData folder).
 *
 * `applyUserDataRelocation()` reads that pointer at the very start of the main
 * process, before any DB/settings access, and calls `app.setPath("userData")`
 * so the entire app transparently uses the new drive (e.g. D:) from then on.
 */

const POINTER_FILENAME = "orianbuilder-data-location.json";

interface UserDataPointer {
  /** Absolute path the app should use as its `userData` directory. */
  userDataPath: string;
}

/**
 * Location of the pointer file. It MUST live outside the userData directory so
 * it survives a relocation. `app.getPath("appData")` is the platform roaming
 * dir (e.g. C:\Users\<u>\AppData\Roaming), the parent of the default userData
 * folder, and is never itself relocated.
 */
export function getDataLocationPointerPath(): string {
  return path.join(app.getPath("appData"), POINTER_FILENAME);
}

function isUsableDirectory(dir: string): boolean {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Reads the relocation pointer. Returns the target path, or null if unset. */
export function readUserDataPointer(): string | null {
  try {
    // Strip a leading UTF-8 BOM if present. Some editors / shells add one and
    // it would otherwise make JSON.parse throw.
    const raw = fs
      .readFileSync(getDataLocationPointerPath(), "utf-8")
      .replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Partial<UserDataPointer>;
    if (parsed && typeof parsed.userDataPath === "string") {
      return parsed.userDataPath;
    }
  } catch {
    // No pointer (default location) or unreadable: treat as unset.
  }
  return null;
}

/**
 * Writes (or, when passed null, removes) the relocation pointer. Does NOT move
 * any data. Callers are responsible for placing the data at `target` first.
 */
export function writeUserDataPointer(target: string | null): void {
  const pointerPath = getDataLocationPointerPath();
  if (target == null) {
    try {
      fs.rmSync(pointerPath, { force: true });
    } catch (err) {
      logger.warn("Failed to remove userData pointer:", err);
    }
    return;
  }
  const payload: UserDataPointer = { userDataPath: target };
  fs.writeFileSync(pointerPath, JSON.stringify(payload, null, 2));
}

let _defaultUserDataPath: string | null = null;

/**
 * The original (un-relocated) userData path. Captured the first time
 * `applyUserDataRelocation` runs, before any `setPath` override, so the rest of
 * the app can still report/reset to the default.
 */
export function getDefaultUserDataPath(): string {
  // If relocation hasn't run yet, the current value IS the default.
  return _defaultUserDataPath ?? app.getPath("userData");
}

/**
 * Reads the pointer and, if it names a usable directory, redirects Electron's
 * `userData` path to it. Call this ONCE at the very top of the main process,
 * before registering IPC handlers or touching the DB/settings.
 */
export function applyUserDataRelocation(): void {
  // Capture the default before any override so we can reset/display it later.
  if (_defaultUserDataPath == null) {
    _defaultUserDataPath = app.getPath("userData");
  }

  const target = readUserDataPointer();
  if (!target) {
    return; // Default location.
  }

  if (path.normalize(target) === path.normalize(_defaultUserDataPath)) {
    // Pointer redundantly names the default; nothing to do.
    return;
  }

  if (!isUsableDirectory(target)) {
    logger.error(
      `Relocated userData path "${target}" is missing or not writable; ` +
        `falling back to default "${_defaultUserDataPath}". ` +
        `Fix the drive/folder or reset the location in Settings.`,
    );
    return;
  }

  try {
    app.setPath("userData", target);
    // Keep Chromium's session data (cache, cookies, GPUCache) on the same drive
    // so nothing accumulates back on the original drive. sessionData defaults to
    // userData, but we set it explicitly to be sure across Electron versions.
    app.setPath("sessionData", target);
    logger.info(`userData relocated to "${target}"`);
  } catch (err) {
    logger.error(`Failed to relocate userData to "${target}":`, err);
  }
}

/** Free space (bytes) on the volume containing `dir`, or null if undetermined. */
export function getFreeSpaceBytes(dir: string): number | null {
  try {
    // statfsSync is available in the Node version bundled with Electron.
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}
