import { app, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import log from "electron-log";
import { createTypedHandler } from "./base";
import { systemContracts } from "../types/system";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import {
  getDefaultUserDataPath,
  getFreeSpaceBytes,
  readUserDataPointer,
  writeUserDataPointer,
} from "../../main/user_data_location";

const logger = log.scope("app_data_location_handlers");

// The relocated userData always lives in an "orianbuilder" subfolder of the
// directory the user picks, so we never dump app state into the root of a drive
// and the layout matches the default (<appData>/orianbuilder).
const DATA_SUBDIR = "orianbuilder";

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

function isNonEmptyDirectory(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** True if `child` is the same as or nested inside `parent`. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Copies a directory tree. Uses robocopy on Windows (handles long paths and
 * large trees robustly; exit codes 0-7 are success), and fs.cp elsewhere.
 */
async function copyTree(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });

  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "robocopy",
        [src, dest, "/E", "/COPY:DAT", "/R:1", "/W:1", "/NFL", "/NDL", "/NP"],
        { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
        (error) => {
          // robocopy uses a bitmask exit code: <8 means success (files copied,
          // extras present, etc.); >=8 indicates at least one failure.
          const code =
            error && typeof (error as any).code === "number"
              ? (error as any).code
              : 0;
          if (code < 8) {
            resolve();
          } else {
            reject(
              new Error(
                `robocopy failed copying ${src} to ${dest} (code ${code})`,
              ),
            );
          }
        },
      );
    });
    return;
  }

  await fs.promises.cp(src, dest, { recursive: true });
}

export function registerAppDataLocationHandlers() {
  createTypedHandler(systemContracts.getAppDataDir, async () => {
    const current = app.getPath("userData");
    const isPathDefault = readUserDataPointer() == null;
    return {
      path: current,
      isPathDefault,
      isPathAvailable: isUsableDirectory(current),
      freeBytes: getFreeSpaceBytes(current),
    };
  });

  createTypedHandler(systemContracts.selectAppDataDir, async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: "Select App Data Folder",
      properties: ["openDirectory", "createDirectory"],
      message:
        "Select the drive/folder where OrianBuilder should store its data and " +
        "downloaded AI models (a subfolder will be created inside it).",
    });

    if (canceled || !filePaths[0]) {
      return { path: null, canceled: true, freeBytes: null };
    }

    const dir = filePaths[0];
    if (!path.isAbsolute(dir) || !isUsableDirectory(dir)) {
      return { path: null, canceled: false, freeBytes: null };
    }
    return { path: dir, canceled: false, freeBytes: getFreeSpaceBytes(dir) };
  });

  createTypedHandler(systemContracts.setAppDataDir, async (_, input) => {
    const currentUserData = app.getPath("userData");

    // Reset to default: just remove the pointer. Existing data on the custom
    // drive is left in place (the user can delete it); the default location's
    // data is used on next launch.
    if (input == null) {
      writeUserDataPointer(null);
      logger.info("App data location reset to default; restart required.");
      return {
        path: getDefaultUserDataPath(),
        moved: false,
        requiresRestart: true,
      };
    }

    if (!path.isAbsolute(input)) {
      throw new OrianBuilderError(
        "App data folder path must be absolute.",
        OrianBuilderErrorKind.Validation,
      );
    }
    if (!isUsableDirectory(input)) {
      throw new OrianBuilderError(
        "Selected folder does not exist or is not writable. Pick a valid folder.",
        OrianBuilderErrorKind.Validation,
      );
    }

    const target = path.join(path.normalize(input), DATA_SUBDIR);

    // Guard against relocating into the current data dir (or a parent of it),
    // which would create an infinite-nesting copy.
    if (
      isInside(currentUserData, target) ||
      isInside(target, currentUserData)
    ) {
      throw new OrianBuilderError(
        "Choose a folder that is not the current app data folder or a parent of it.",
        OrianBuilderErrorKind.Validation,
      );
    }

    if (path.normalize(target) === path.normalize(currentUserData)) {
      // Already there: nothing to move, just (re)write the pointer.
      writeUserDataPointer(target);
      return { path: target, moved: false, requiresRestart: false };
    }

    // If the target is already populated (e.g. data was moved out-of-band),
    // adopt it without copying.
    if (isNonEmptyDirectory(target)) {
      logger.info(
        `Target ${target} already contains data; adopting it without copying.`,
      );
      writeUserDataPointer(target);
      return { path: target, moved: false, requiresRestart: true };
    }

    logger.info(`Copying app data: ${currentUserData} to ${target}`);
    await copyTree(currentUserData, target);
    logger.info("App data copy complete; writing pointer.");
    writeUserDataPointer(target);

    return { path: target, moved: true, requiresRestart: true };
  });
}
