/**
 * IPC surface for the self-managed Android test runner (see
 * src/main/android/android_sdk_manager.ts).
 *
 * - `getStatus` reports whether the SDK / system image are present and whether
 *   an emulator is currently running.
 * - `setup` downloads the minimal SDK components, streaming progress on
 *   `android_emulator:setup-progress` (same pattern as the llama binary
 *   downloader). The managed SDK path is persisted to user settings so it
 *   survives restarts.
 * - `findApk` locates a built APK + its package id for a given app.
 * - `launchAndInstall` boots the AVD, installs the APK and launches it.
 * - `stop` kills the emulator process.
 */

import fs from "node:fs";
import path from "node:path";
import log from "electron-log";
import { BrowserWindow } from "electron";
import { eq } from "drizzle-orm";

import { createTypedHandler } from "./base";
import {
  androidEmulatorContracts,
  androidEmulatorEvents,
} from "@/ipc/types/android_emulator";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { getOrianBuilderAppPath } from "@/paths/paths";
import { readSettings, writeSettings } from "@/main/settings";
import {
  getEmulatorStatus,
  setupAndroidSdk,
  launchAndInstall,
  stopEmulator,
  getManagedSdkRoot,
  buildDebugApk,
} from "@/main/android/android_sdk_manager";

const logger = log.scope("android_emulator_handlers");

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

let activeAbortController: AbortController | null = null;
let activeBuildController: AbortController | null = null;

async function resolveAppPath(appId: number): Promise<string> {
  const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
  if (!app) {
    throw new OrianBuilderError(
      `App not found: ${appId}`,
      OrianBuilderErrorKind.NotFound,
    );
  }
  return getOrianBuilderAppPath(app.path);
}

/**
 * Best-effort extraction of the Capacitor `appId` (Android package id) from a
 * project's capacitor config. Supports JSON as well as the common
 * `appId: "com.example.app"` pattern in .ts / .js configs.
 */
function readCapacitorPackageId(appPath: string): string | null {
  const jsonPath = path.join(appPath, "capacitor.config.json");
  if (fs.existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      if (typeof parsed.appId === "string") return parsed.appId;
    } catch {
      // fall through to regex-based parsing
    }
  }
  for (const name of ["capacitor.config.ts", "capacitor.config.js"]) {
    const p = path.join(appPath, name);
    if (!fs.existsSync(p)) continue;
    try {
      const src = fs.readFileSync(p, "utf-8");
      const match = /appId\s*:\s*["'`]([^"'`]+)["'`]/.exec(src);
      if (match) return match[1];
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Locate a built APK for the app. Prefers the Capacitor debug build output,
 * then release, then any APK staged under the native download site.
 */
function findApkPath(appPath: string): string | null {
  const candidates = [
    path.join(appPath, "android", "app", "build", "outputs", "apk", "debug"),
    path.join(appPath, "android", "app", "build", "outputs", "apk", "release"),
    path.join(appPath, "native-download-site", "downloads"),
  ];
  for (const dir of candidates) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const apk = entries.find((name) => name.toLowerCase().endsWith(".apk"));
    if (apk) return path.join(dir, apk);
  }
  return null;
}

export function registerAndroidEmulatorHandlers(): void {
  createTypedHandler(androidEmulatorContracts.getStatus, async () => {
    return getEmulatorStatus();
  });

  createTypedHandler(androidEmulatorContracts.setup, async () => {
    if (activeAbortController) {
      return { ok: false, error: "Setup is already in progress." };
    }
    activeAbortController = new AbortController();
    const signal = activeAbortController.signal;
    try {
      await setupAndroidSdk(
        (progress) =>
          broadcast(androidEmulatorEvents.setupProgress.channel, progress),
        signal,
      );
      // Persist the *actually resolved* managed SDK path so it survives
      // restarts (and so a stale path that pointed at a full drive is
      // corrected to wherever the runtime really landed).
      const resolved = getManagedSdkRoot();
      if (readSettings().androidSdkManagedPath !== resolved) {
        writeSettings({ androidSdkManagedPath: resolved });
      }
      return { ok: true, error: null };
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return { ok: false, error: "Setup cancelled." };
      }
      logger.error("Android SDK setup failed", err);
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      activeAbortController = null;
    }
  });

  createTypedHandler(androidEmulatorContracts.abort, async () => {
    activeAbortController?.abort();
    activeAbortController = null;
  });

  createTypedHandler(androidEmulatorContracts.findApk, async (_, { appId }) => {
    const appPath = await resolveAppPath(appId);
    return {
      apkPath: findApkPath(appPath),
      packageId: readCapacitorPackageId(appPath),
    };
  });

  createTypedHandler(
    androidEmulatorContracts.launchAndInstall,
    async (_, params) => {
      try {
        await launchAndInstall({
          apkPath: params.apkPath,
          packageId: params.packageId ?? null,
        });
        return { ok: true, error: null };
      } catch (err: any) {
        logger.error("Failed to launch APK in emulator", err);
        return { ok: false, error: String(err?.message ?? err) };
      }
    },
  );

  createTypedHandler(
    androidEmulatorContracts.buildApk,
    async (_, { appId }) => {
      if (activeBuildController) {
        return {
          ok: false,
          error: "A build is already in progress.",
          apkPath: null,
        };
      }
      activeBuildController = new AbortController();
      try {
        const appPath = await resolveAppPath(appId);
        const apkPath = await buildDebugApk({
          appPath,
          onLog: (line) =>
            broadcast(androidEmulatorEvents.buildLog.channel, { line }),
          signal: activeBuildController.signal,
        });
        return { ok: true, error: null, apkPath };
      } catch (err: any) {
        if (err?.kind === "user_cancelled" || err?.name === "AbortError") {
          return { ok: false, error: "Build cancelled.", apkPath: null };
        }
        logger.error("APK build failed", err);
        return { ok: false, error: String(err?.message ?? err), apkPath: null };
      } finally {
        activeBuildController = null;
      }
    },
  );

  createTypedHandler(androidEmulatorContracts.abortBuild, async () => {
    activeBuildController?.abort();
    activeBuildController = null;
  });

  createTypedHandler(androidEmulatorContracts.stop, async () => {
    stopEmulator();
    return { ok: true, error: null };
  });
}
