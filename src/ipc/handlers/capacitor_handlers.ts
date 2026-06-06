import log from "electron-log";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
import { getOrianBuilderAppPath } from "../../paths/paths";
import fs from "node:fs";
import path from "node:path";
import { simpleSpawn } from "../utils/simpleSpawn";
import { IS_TEST_BUILD } from "../utils/test_utils";
import { createTypedHandler } from "./base";
import { capacitorContracts } from "../types/capacitor";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";

const logger = log.scope("capacitor_handlers");

async function getApp(appId: number) {
  const app = await db.query.apps.findFirst({
    where: eq(apps.id, appId),
  });
  if (!app) {
    throw new OrianBuilderError(
      `App with id ${appId} not found`,
      OrianBuilderErrorKind.NotFound,
    );
  }
  return app;
}

function isCapacitorInstalled(appPath: string): boolean {
  const capacitorConfigJs = path.join(appPath, "capacitor.config.js");
  const capacitorConfigTs = path.join(appPath, "capacitor.config.ts");
  const capacitorConfigJson = path.join(appPath, "capacitor.config.json");

  return (
    fs.existsSync(capacitorConfigJs) ||
    fs.existsSync(capacitorConfigTs) ||
    fs.existsSync(capacitorConfigJson)
  );
}

/**
 * Resolve the Android Studio launcher path the way Capacitor does — honoring
 * CAPACITOR_ANDROID_STUDIO_PATH, then platform defaults.
 */
function resolveAndroidStudioPath(): string | null {
  if (process.env.CAPACITOR_ANDROID_STUDIO_PATH) {
    return process.env.CAPACITOR_ANDROID_STUDIO_PATH;
  }
  const defaults =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe",
          "C:\\Program Files\\Android\\Android Studio\\bin\\studio.exe",
        ]
      : process.platform === "darwin"
        ? ["/Applications/Android Studio.app"]
        : [
            "/usr/local/android-studio/bin/studio.sh",
            "/opt/android-studio/bin/studio.sh",
          ];
  return defaults.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Whether Android Studio is present AND its installation is intact. A common
 * failure mode is a launcher (studio64.exe) without the rest of the IDE — most
 * tellingly the `product-info.json` descriptor — which makes the IDE crash on
 * startup with "Cannot detect a launch configuration". We detect that here so
 * we can show a helpful message instead of launching a broken IDE.
 */
function isAndroidStudioUsable(): boolean {
  const studioPath = resolveAndroidStudioPath();
  if (!studioPath) return false;
  if (process.platform === "darwin") {
    return fs.existsSync(path.join(studioPath, "Contents", "Info.plist"));
  }
  // studioPath is <root>/bin/studio64.exe — a valid install has the JetBrains
  // product descriptor at its root.
  const installRoot = path.dirname(path.dirname(studioPath));
  return fs.existsSync(path.join(installRoot, "product-info.json"));
}

/** Whether Xcode is available. iOS tooling only exists on macOS. */
function isXcodeAvailable(): boolean {
  return (
    process.platform === "darwin" && fs.existsSync("/Applications/Xcode.app")
  );
}

export function registerCapacitorHandlers() {
  createTypedHandler(capacitorContracts.isCapacitor, async (_, params) => {
    const app = await getApp(params.appId);
    const appPath = getOrianBuilderAppPath(app.path);

    // check for the required Node.js version before running any commands
    const currentNodeVersion = process.version;
    const majorVersion = parseInt(
      currentNodeVersion.slice(1).split(".")[0],
      10,
    );

    if (majorVersion < 20) {
      // version is too old? stop and throw a clear error
      throw new Error(
        `Capacitor requires Node.js v20 or higher, but you are using ${currentNodeVersion}. Please upgrade your Node.js and try again.`,
      );
    }
    return isCapacitorInstalled(appPath);
  });

  createTypedHandler(capacitorContracts.syncCapacitor, async (_, params) => {
    const app = await getApp(params.appId);
    const appPath = getOrianBuilderAppPath(app.path);

    if (!isCapacitorInstalled(appPath)) {
      throw new OrianBuilderError(
        "Capacitor is not installed in this app",
        OrianBuilderErrorKind.Precondition,
      );
    }

    await simpleSpawn({
      command: "npm run build",
      cwd: appPath,
      successMessage: "App built successfully",
      errorPrefix: "Failed to build app",
    });

    await simpleSpawn({
      command: "npx cap sync",
      cwd: appPath,
      successMessage: "Capacitor sync completed successfully",
      errorPrefix: "Failed to sync Capacitor",
      env: {
        ...process.env,
        LANG: "en_US.UTF-8",
      },
    });
  });

  createTypedHandler(capacitorContracts.openIos, async (_, params) => {
    const app = await getApp(params.appId);
    const appPath = getOrianBuilderAppPath(app.path);

    if (!isCapacitorInstalled(appPath)) {
      throw new OrianBuilderError(
        "Capacitor is not installed in this app",
        OrianBuilderErrorKind.Precondition,
      );
    }

    if (IS_TEST_BUILD) {
      // In test mode, just log the action instead of actually opening Xcode
      logger.info("Test mode: Simulating opening iOS project in Xcode");
      return;
    }

    await simpleSpawn({
      command: "npx cap open ios",
      cwd: appPath,
      successMessage: "iOS project opened successfully",
      errorPrefix: "Failed to open iOS project",
    });
  });

  createTypedHandler(capacitorContracts.isAndroidStudioAvailable, async () =>
    isAndroidStudioUsable(),
  );

  createTypedHandler(capacitorContracts.isXcodeAvailable, async () =>
    isXcodeAvailable(),
  );

  createTypedHandler(capacitorContracts.openAndroid, async (_, params) => {
    const app = await getApp(params.appId);
    const appPath = getOrianBuilderAppPath(app.path);

    if (!isCapacitorInstalled(appPath)) {
      throw new OrianBuilderError(
        "Capacitor is not installed in this app",
        OrianBuilderErrorKind.Precondition,
      );
    }

    if (IS_TEST_BUILD) {
      // In test mode, just log the action instead of actually opening Android Studio
      logger.info(
        "Test mode: Simulating opening Android project in Android Studio",
      );
      return;
    }

    // Don't launch a broken/absent Android Studio — it would pop its own cryptic
    // "Cannot start the IDE" dialog. Surface a helpful message instead.
    if (!isAndroidStudioUsable()) {
      throw new OrianBuilderError(
        "Android Studio isn't installed (or its installation is incomplete), so it can't be opened.\n\n" +
          "You don't need Android Studio to test on Android — use the “Android Test” panel below to build a debug APK and launch it in the emulator directly.\n\n" +
          "If you'd rather use this button, reinstall Android Studio from https://developer.android.com/studio (or set CAPACITOR_ANDROID_STUDIO_PATH to a working install).",
        OrianBuilderErrorKind.Precondition,
      );
    }

    await simpleSpawn({
      command: "npx cap open android",
      cwd: appPath,
      successMessage: "Android project opened successfully",
      errorPrefix: "Failed to open Android project",
    });
  });
}
