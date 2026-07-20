import { db } from "../../../db";
import { apps } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { createTypedHandler } from "../base";
import { appContracts } from "../../types/app";
import { miscContracts } from "../../types/misc";
import fs from "node:fs";
import path from "node:path";
import { getOrianBuilderAppPath } from "../../../paths/paths";
import { promises as fsPromises } from "node:fs";
import { withLock } from "../../utils/lock_utils";
import {
  runningApps,
  stopAppByInfo,
  removeDockerVolumesForApp,
  startAppGarbageCollection,
} from "../../utils/process_manager";
import { readSettings } from "../../../main/settings";
import { addLog, clearLogs } from "../../../lib/log_store";
import {
  reconcileCloudSandboxes,
  restartCloudSandbox,
} from "../../utils/cloud_sandbox_provider";
import { getAppPort } from "../../../../shared/ports";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import {
  cleanUpPort,
  executeApp,
  logger,
  registerCloudSandboxSyncUpdateListener,
  runAppById,
  startCloudSandboxLogStream,
  stopAppById,
  ensureProxyForRunningApp,
} from "./app_shared";
import { isOrionSessionAppId } from "@/shared/orion_session";
/**
 * App execution, process, command, and log IPC handlers.
 */

export function registerAppExecutionHandlers() {
  registerCloudSandboxSyncUpdateListener();

  createTypedHandler(appContracts.runApp, async (event, params) => {
    await runAppById(event, params.appId);
  });

  createTypedHandler(appContracts.stopApp, async (_, params) => {
    await stopAppById(params.appId);
  });

  createTypedHandler(appContracts.restartApp, async (event, params) => {
    const { appId, removeNodeModules, recreateSandbox } = params;
    if (
      isOrionSessionAppId(
        appId,
        readSettings() as ReturnType<typeof readSettings> & {
          orionSessionAppId?: unknown;
        },
      )
    ) {
      logger.debug(
        `Ignoring preview restart for internal Orion session app ${appId}.`,
      );
      return;
    }
    logger.log(`Restarting app ${appId}`);
    return withLock(appId, async () => {
      try {
        const app = await db.query.apps.findFirst({
          where: eq(apps.id, appId),
        });

        if (!app) {
          throw new OrianBuilderError(
            "App not found",
            OrianBuilderErrorKind.NotFound,
          );
        }

        const appPath = getOrianBuilderAppPath(app.path);

        // First stop the app if it's running
        const appInfo = runningApps.get(appId);
        if (
          appInfo &&
          appInfo.mode === "cloud" &&
          appInfo.cloudSandboxId &&
          !recreateSandbox
        ) {
          logger.log(`Restarting cloud sandbox app ${appId} in place`);

          const restartResult = await restartCloudSandbox(
            appInfo.cloudSandboxId,
          );
          appInfo.cloudPreviewUrl = restartResult.previewUrl;
          appInfo.cloudPreviewAuthToken = restartResult.previewAuthToken;
          appInfo.lastViewedAt = Date.now();

          appInfo.cloudLogAbortController?.abort();
          appInfo.cloudLogAbortController = new AbortController();

          await ensureProxyForRunningApp({
            appId,
            event,
            originalUrl: restartResult.previewUrl,
            mode: "cloud",
          });

          startCloudSandboxLogStream({
            appId,
            event,
            sandboxId: appInfo.cloudSandboxId,
            cloudLogAbortController: appInfo.cloudLogAbortController,
          });
          return;
        }

        if (appInfo) {
          const { processId } = appInfo;
          logger.log(
            `Stopping app ${appId} (processId ${processId}) before restart`,
          );
          await stopAppByInfo(appId, appInfo);
        } else {
          logger.log(`App ${appId} not running. Proceeding to start.`);
        }

        // There may have been a previous run that left a process on this port.
        await cleanUpPort(getAppPort(appId));

        // Remove node_modules if requested
        if (removeNodeModules) {
          const settings = readSettings();
          const runtimeMode = settings.runtimeMode2 ?? "host";

          const nodeModulesPath = path.join(appPath, "node_modules");
          logger.log(
            `Removing node_modules for app ${appId} at ${nodeModulesPath}`,
          );
          if (fs.existsSync(nodeModulesPath)) {
            await fsPromises.rm(nodeModulesPath, {
              recursive: true,
              force: true,
            });
            logger.log(`Successfully removed node_modules for app ${appId}`);
          } else {
            logger.log(`No node_modules directory found for app ${appId}`);
          }

          // If running in Docker mode, also remove container volumes so deps reinstall freshly
          if (runtimeMode === "docker") {
            logger.log(
              `Docker mode detected for app ${appId}. Removing Docker volumes orianbuilder-pnpm-${appId}...`,
            );
            try {
              await removeDockerVolumesForApp(appId);
              logger.log(
                `Removed Docker volumes for app ${appId} (orianbuilder-pnpm-${appId}).`,
              );
            } catch (e) {
              // Best-effort cleanup; log and continue
              logger.warn(
                `Failed to remove Docker volumes for app ${appId}. Continuing: ${e}`,
              );
            }
          }
        }

        logger.debug(
          `Executing app ${appId} in path ${app.path} after restart request`,
        ); // Adjusted log

        await executeApp({
          appPath,
          appId,
          event,
          isNeon: !!app.neonProjectId,
          installCommand: app.installCommand,
          startCommand: app.startCommand,
        }); // This will handle starting either mode

        return;
      } catch (error) {
        logger.error(`Error restarting app ${appId}:`, error);
        console.error(error);
        throw error;
      }
    });
  });

  createTypedHandler(appContracts.respondToAppInput, async (_, params) => {
    const { appId, response } = params;
    const allowedResponses = new Set(["y", "n", "a", "i", "w", "r"]);
    if (!allowedResponses.has(response)) {
      throw new OrianBuilderError(
        `Invalid response: ${response}`,
        OrianBuilderErrorKind.Validation,
      );
    }
    const appInfo = runningApps.get(appId);

    if (!appInfo) {
      throw new OrianBuilderError(
        `App ${appId} is not running`,
        OrianBuilderErrorKind.External,
      );
    }

    const { process } = appInfo;
    if (!process) {
      throw new Error(
        `App ${appId} is running in ${appInfo.mode} mode and does not accept stdin responses.`,
      );
    }

    if (!process.stdin) {
      throw new OrianBuilderError(
        `App ${appId} process has no stdin available`,
        OrianBuilderErrorKind.External,
      );
    }

    try {
      // Write the response to stdin with a newline
      process.stdin.write(`${response}\n`);
      logger.debug(`Sent response '${response}' to app ${appId} stdin`);
    } catch (error: any) {
      logger.error(`Error sending response to app ${appId}:`, error);
      throw new OrianBuilderError(
        `Failed to send response to app: ${error.message}`,
        OrianBuilderErrorKind.External,
      );
    }
  });

  createTypedHandler(miscContracts.addLog, async (_, entry) => {
    addLog(entry);
  });

  // Handler for clearing logs for a specific app

  createTypedHandler(miscContracts.clearLogs, async (_, { appId }) => {
    clearLogs(appId);
  });

  // select-app-location is not in app contracts - keep using handle

  createTypedHandler(appContracts.updateAppCommands, async (_, params) => {
    const { appId, installCommand, startCommand } = params;

    const app = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
    });

    if (!app) {
      throw new OrianBuilderError(
        "App not found",
        OrianBuilderErrorKind.NotFound,
      );
    }

    const trimmedInstall = installCommand?.trim() || null;
    const trimmedStart = startCommand?.trim() || null;

    // Both commands must be provided together, or both must be null
    if ((trimmedInstall === null) !== (trimmedStart === null)) {
      throw new Error(
        "Both install and start commands are required when customizing",
      );
    }

    await db
      .update(apps)
      .set({
        installCommand: trimmedInstall,
        startCommand: trimmedStart,
      })
      .where(eq(apps.id, appId));

    logger.info(`Updated commands for app ${appId}`);
  });

  const proApiKey =
    readSettings().providerSettings?.auto?.apiKey?.value?.trim();
  if (proApiKey) {
    void reconcileCloudSandboxes().catch((error) => {
      logger.warn("Failed to reconcile cloud sandboxes on startup:", error);
    });
  }

  // Start the garbage collection for idle apps

  startAppGarbageCollection();
}

export { runAppById, stopAppById } from "./app_shared";
