import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow } from "electron";
import log from "electron-log";
import { godotContracts, godotEvents, blenderContracts } from "../types/game";
import { createTypedHandler } from "./base";
import {
  GODOT_DOWNLOAD_URL,
  invalidateGodotCache,
  locateGodot,
  setGodotExecutable,
} from "@/main/godot/locate";
import { getGodotController } from "@/main/godot/process";
import {
  createGodotProject,
  findGodotProject,
  importAsset,
  listAssets,
  readGodotProject,
  type GodotAssetKind,
} from "@/main/godot/project";
import { checkProject, exportProject } from "@/main/godot/export";
import {
  invalidateBlenderCache,
  locateBlender,
  setBlenderExecutable,
} from "@/main/blender/locate";
import { runBlender } from "@/main/blender/run";
import type { BlenderOp } from "@/main/blender/harness";
import { getOrianBuilderAppPath } from "@/paths/paths";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";

const logger = log.scope("game-handlers");

/** Resolves an app id to its on-disk path. */
async function appPathFor(appId: number): Promise<string> {
  const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
  if (!app) throw new Error(`No app with id ${appId}`);
  return getOrianBuilderAppPath(app.path);
}

/**
 * Broadcasts engine status to every window.
 *
 * Registered once at handler-registration time rather than per-subscriber: the
 * controller is a singleton and a listener leak here would keep dead
 * BrowserWindows referenced for the life of the process.
 */
function wireStatusBroadcast(): void {
  getGodotController().onChange((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(godotEvents.statusChanged.channel, status);
    }
  });
}

export function registerGameHandlers(): void {
  wireStatusBroadcast();

  // ── Godot: discovery ─────────────────────────────────────────────────────

  createTypedHandler(godotContracts.locate, async (_event, input) => {
    if (input?.force) invalidateGodotCache();
    const install = await locateGodot({ force: input?.force });
    if (!install) {
      logger.info(`No Godot engine found. Download: ${GODOT_DOWNLOAD_URL}`);
    }
    return install;
  });

  createTypedHandler(godotContracts.setExecutable, async (_event, input) => {
    return setGodotExecutable(input.executable);
  });

  // ── Godot: lifecycle ─────────────────────────────────────────────────────

  createTypedHandler(godotContracts.status, async () => {
    const controller = getGodotController();
    const status = await controller.reconcile();
    // Attach discovery here rather than inside the controller so the controller
    // stays free of settings/IO concerns.
    return { ...status, install: await locateGodot() };
  });

  createTypedHandler(godotContracts.start, async (_event, input) => {
    let projectDir = input.projectDir;
    if (!projectDir) {
      if (input.appId == null) {
        throw new Error("start needs either projectDir or appId");
      }
      const appPath = await appPathFor(input.appId);
      const found = await findGodotProject(appPath);
      if (!found) {
        throw new Error(
          `No project.godot under ${appPath}. Create a Godot project for this app first.`,
        );
      }
      projectDir = found;
    }
    const status = await getGodotController().start({
      projectDir,
      mode: input.mode,
      args: input.args,
    });
    return { ...status, install: await locateGodot() };
  });

  createTypedHandler(godotContracts.stop, async () => {
    const status = await getGodotController().stop();
    return { ...status, install: await locateGodot() };
  });

  // ── Godot: live engine control ───────────────────────────────────────────

  createTypedHandler(godotContracts.call, async (_event, input) => {
    const client = getGodotController().client();
    if (!client) {
      return { ok: false, error: "Godot is not running." };
    }
    try {
      return await client.call(
        input.action,
        input.params ?? {},
        input.timeoutMs,
      );
    } catch (err) {
      // Transport failure — surfaced as a normal op failure so the caller
      // (inspector or agent) handles one shape, not two.
      return { ok: false, error: (err as Error).message };
    }
  });

  createTypedHandler(godotContracts.viewport, async () => {
    const controller = getGodotController();
    const client = controller.client();
    if (!client || !controller.isRunning()) {
      return {
        ok: false,
        dataUrl: null,
        width: null,
        height: null,
        error: "Godot is not running.",
      };
    }
    try {
      const res = await client.screenshot();
      if (res.ok !== true || typeof res.path !== "string") {
        return {
          ok: false,
          dataUrl: null,
          width: null,
          height: null,
          error: (res.error as string) ?? "screenshot failed",
        };
      }
      // Inlined as a data URL rather than served over a file:// path: the
      // renderer runs under a CSP that blocks arbitrary local files, and the
      // frames are transient anyway.
      const bytes = await fs.readFile(res.path);
      return {
        ok: true,
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
        width: typeof res.width === "number" ? res.width : null,
        height: typeof res.height === "number" ? res.height : null,
        error: null,
      };
    } catch (err) {
      return {
        ok: false,
        dataUrl: null,
        width: null,
        height: null,
        error: (err as Error).message,
      };
    }
  });

  // ── Godot: projects and assets ───────────────────────────────────────────

  createTypedHandler(godotContracts.findProject, async (_event, input) => {
    const appPath = await appPathFor(input.appId);
    const dir = await findGodotProject(appPath);
    return dir ? await readGodotProject(dir) : null;
  });

  createTypedHandler(godotContracts.createProject, async (_event, input) => {
    const appPath = await appPathFor(input.appId);
    const dir = input.subdir ? path.join(appPath, input.subdir) : appPath;
    return createGodotProject({
      dir,
      name: input.name ?? path.basename(appPath),
      template: input.template,
    });
  });

  createTypedHandler(godotContracts.listAssets, async (_event, input) => {
    return listAssets(input.projectDir);
  });

  createTypedHandler(godotContracts.importAsset, async (_event, input) => {
    return importAsset({
      projectDir: input.projectDir,
      sourcePath: input.sourcePath,
      kind: input.kind as GodotAssetKind,
      fileName: input.fileName,
    });
  });

  createTypedHandler(godotContracts.checkProject, async (_event, input) => {
    return checkProject(input.projectDir);
  });

  createTypedHandler(godotContracts.exportProject, async (_event, input) => {
    return exportProject({
      projectDir: input.projectDir,
      target: input.target,
      outputPath: input.outputPath,
      debug: input.debug,
    });
  });

  // ── Blender ──────────────────────────────────────────────────────────────

  createTypedHandler(blenderContracts.locate, async (_event, input) => {
    if (input?.force) invalidateBlenderCache();
    return locateBlender({ force: input?.force });
  });

  createTypedHandler(blenderContracts.setExecutable, async (_event, input) => {
    return setBlenderExecutable(input.executable);
  });

  createTypedHandler(blenderContracts.run, async (_event, input) => {
    // The op name and its params are flattened into one request object, which is
    // the shape the Blender harness reads from its JSON file.
    const request = Object.assign(
      { op: input.op as BlenderOp },
      input.params ?? {},
    );
    return runBlender(request, { timeoutMs: input.timeoutMs });
  });
}
