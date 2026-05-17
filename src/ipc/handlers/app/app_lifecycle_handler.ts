import { ipcMain, app, dialog } from "electron";
import { db, getDatabasePath } from "../../../db";
import { apps, chats, messages } from "../../../db/schema";
import { desc, eq, like } from "drizzle-orm";
import { createTypedHandler } from "../base";
import { appContracts } from "../../types/app";
import { systemContracts } from "../../types/system";
import fs from "node:fs";
import path from "node:path";
import {
  getOrianBuilderAppPath,
  getDefaultOrianBuilderAppsDirectory,
  isAppLocationAccessible,
  getUserDataPath,
  getOrianBuilderAppsBaseDirectory,
  invalidateOrianBuilderAppsBaseDirectoryCache,
} from "../../../paths/paths";
import { promises as fsPromises } from "node:fs";
import { withLock } from "../../utils/lock_utils";
import { getFilesRecursively } from "../../utils/file_utils";
import { runningApps, stopAppByInfo } from "../../utils/process_manager";
import { getEnvVar } from "../../utils/read_env";
import { readSettings } from "../../../main/settings";
import { clearLogs } from "../../../lib/log_store";
import {
  deploySupabaseFunction,
  getSupabaseProjectName,
} from "../../../supabase_admin/supabase_management_client";
import { getLanguageModelProviders } from "../../shared/language_model_helpers";
import { queueCloudSandboxSnapshotSync } from "../../utils/cloud_sandbox_provider";
import { createFromTemplate } from "../createFromTemplate";
import { getInitialChatModeForNewChat } from "../chat_mode_resolution";
import { gitCommit, gitAdd, gitInit } from "../../utils/git_utils";
import { normalizePath } from "../../../../shared/normalizePath";
import {
  isServerFunction,
  isSharedServerModule,
  deployAllSupabaseFunctions,
  extractFunctionNameFromPath,
} from "@/supabase_admin/supabase_utils";
import { getVercelTeamSlug } from "../../utils/vercel_utils";
import { storeDbTimestampAtCurrentVersion } from "../../utils/neon_timestamp_utils";
import type { AppSearchResult } from "@/lib/schemas";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { detectFrameworkType } from "../../utils/framework_utils";
import { exportProjectZip } from "../../utils/zip_export";
import {
  copyDir,
  getTemplateRuntimeCommands,
  handle,
  logger,
  searchAppFilesWithRipgrep,
} from "./app_shared";
/**
 * App lifecycle, file, search, and system IPC handlers.
 */

export function registerAppLifecycleHandlers() {
  createTypedHandler(systemContracts.restartOrianBuilder, async () => {
    app.relaunch();
    app.quit();
  });

  createTypedHandler(appContracts.createApp, async (_, params) => {
    const appPath = params.name;
    const fullAppPath = getOrianBuilderAppPath(appPath);
    const templateRuntimeCommands = getTemplateRuntimeCommands(
      params.templateId,
    );

    if (!isAppLocationAccessible(fullAppPath)) {
      throw new Error(
        `The path ${fullAppPath} is inaccessible. Please check your custom apps folder setting.`,
      );
    }

    if (fs.existsSync(fullAppPath)) {
      throw new OrianBuilderError(
        `App already exists at: ${fullAppPath}`,
        OrianBuilderErrorKind.Conflict,
      );
    }
    // Create a new app
    const [app] = await db
      .insert(apps)
      .values({
        name: params.name,
        // Use the name as the path for now
        path: appPath,
        installCommand: templateRuntimeCommands.installCommand,
        startCommand: templateRuntimeCommands.startCommand,
      })
      .returning();

    const initialChatMode = await getInitialChatModeForNewChat(
      params.initialChatMode,
    );

    // Create an initial chat for this app
    const [chat] = await db
      .insert(chats)
      .values({
        appId: app.id,
        chatMode: initialChatMode,
      })
      .returning();

    await createFromTemplate({
      fullAppPath,
      templateId: params.templateId,
    });

    // Initialize git repo and create first commit

    await gitInit({ path: fullAppPath, ref: "main" });

    // Stage all files
    await gitAdd({ path: fullAppPath, filepath: "." });

    // Create initial commit
    const commitHash = await gitCommit({
      path: fullAppPath,
      message: "Init OrianBuilder app",
    });

    // Update chat with initial commit hash
    await db
      .update(chats)
      .set({
        initialCommitHash: commitHash,
      })
      .where(eq(chats.id, chat.id));

    return {
      app: { ...app, resolvedPath: fullAppPath },
      chatId: chat.id,
    };
  });

  createTypedHandler(appContracts.copyApp, async (_, params) => {
    const { appId, newAppName, withHistory } = params;

    // 1. Check if an app with the new name already exists
    const existingApp = await db.query.apps.findFirst({
      where: eq(apps.name, newAppName),
    });

    if (existingApp) {
      throw new OrianBuilderError(
        `An app named "${newAppName}" already exists.`,
        OrianBuilderErrorKind.Conflict,
      );
    }

    // 2. Find the original app
    const originalApp = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
    });

    if (!originalApp) {
      throw new OrianBuilderError(
        "Original app not found.",
        OrianBuilderErrorKind.NotFound,
      );
    }

    const originalAppPath = getOrianBuilderAppPath(originalApp.path);
    const newAppPath = getOrianBuilderAppPath(newAppName);

    if (!isAppLocationAccessible(newAppPath)) {
      throw new Error(
        `The path ${newAppPath} is inaccessible. Please check your custom apps folder setting.`,
      );
    }

    // 3. Copy the app folder
    try {
      await copyDir(
        originalAppPath,
        newAppPath,
        (source: string) => {
          if (!withHistory && path.basename(source) === ".git") {
            return false;
          }
          return true;
        },
        { excludeNodeModules: true },
      );
    } catch (error) {
      logger.error("Failed to copy app directory:", error);
      throw new OrianBuilderError(
        "Failed to copy app directory.",
        OrianBuilderErrorKind.External,
      );
    }

    if (!withHistory) {
      // Initialize git repo and create first commit
      await gitInit({ path: newAppPath, ref: "main" });

      // Stage all files
      await gitAdd({ path: newAppPath, filepath: "." });

      // Create initial commit
      await gitCommit({
        path: newAppPath,
        message: "Init OrianBuilder app",
      });
    }

    // 4. Create a new app entry in the database
    const [newDbApp] = await db
      .insert(apps)
      .values({
        name: newAppName,
        path: newAppName, // Use the new name for the path
        // Explicitly set these to null because we don't want to copy them over.
        // Note: we could just leave them out since they're nullable field, but this
        // is to make it explicit we intentionally don't want to copy them over.
        supabaseProjectId: null,
        githubOrg: null,
        githubRepo: null,
        installCommand: originalApp.installCommand,
        startCommand: originalApp.startCommand,
      })
      .returning();

    return { app: newDbApp };
  });

  createTypedHandler(appContracts.getApp, async (_, appId) => {
    const app = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
    });

    if (!app) {
      throw new OrianBuilderError(
        "App not found",
        OrianBuilderErrorKind.NotFound,
      );
    }

    // Get app files
    const appPath = getOrianBuilderAppPath(app.path);
    let files: string[] = [];

    try {
      files = getFilesRecursively(appPath, appPath);
      // Normalize the path to use forward slashes so file tree (UI)
      // can parse it more consistently across platforms.
      files = files.map((path) => normalizePath(path));
    } catch (error) {
      logger.error(`Error reading files for app ${appId}:`, error);
      // Return app even if files couldn't be read
    }

    let supabaseProjectName: string | null = null;
    const settings = readSettings();
    // Check for multi-organization credentials or legacy single account
    const hasSupabaseCredentials =
      (app.supabaseOrganizationSlug &&
        settings.supabase?.organizations?.[app.supabaseOrganizationSlug]
          ?.accessToken?.value) ||
      settings.supabase?.accessToken?.value;
    if (app.supabaseProjectId && hasSupabaseCredentials) {
      supabaseProjectName = await getSupabaseProjectName(
        app.supabaseParentProjectId || app.supabaseProjectId,
        app.supabaseOrganizationSlug ?? undefined,
      );
    }

    let vercelTeamSlug: string | null = null;
    if (app.vercelTeamId) {
      vercelTeamSlug = await getVercelTeamSlug(app.vercelTeamId);
    }

    return {
      ...app,
      files,
      frameworkType: detectFrameworkType(appPath),
      resolvedPath: appPath,
      supabaseProjectName,
      vercelTeamSlug,
    };
  });

  createTypedHandler(appContracts.listApps, async () => {
    const allApps = await db.query.apps.findMany({
      orderBy: [desc(apps.createdAt)],
    });
    const appsWithResolvedPath = allApps.map((app) => ({
      ...app,
      resolvedPath: getOrianBuilderAppPath(app.path),
    }));
    return {
      apps: appsWithResolvedPath,
    };
  });

  createTypedHandler(appContracts.readAppFile, async (_, params) => {
    const { appId, filePath } = params;
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
    const fullPath = path.join(appPath, filePath);

    // Check if the path is within the app directory (security check)
    if (!fullPath.startsWith(appPath)) {
      throw new OrianBuilderError(
        "Invalid file path",
        OrianBuilderErrorKind.Validation,
      );
    }

    if (!fs.existsSync(fullPath)) {
      throw new OrianBuilderError(
        "File not found",
        OrianBuilderErrorKind.NotFound,
      );
    }

    try {
      const contents = fs.readFileSync(fullPath, "utf-8");
      return contents;
    } catch (error) {
      logger.error(`Error reading file ${filePath} for app ${appId}:`, error);
      throw new OrianBuilderError(
        "Failed to read file",
        OrianBuilderErrorKind.External,
      );
    }
  });

  // Do NOT use typed handler for this, it contains sensitive information.

  ipcMain.handle("get-env-vars", async () => {
    const envVars: Record<string, string | undefined> = {};
    const providers = await getLanguageModelProviders();
    for (const provider of providers) {
      if (provider.envVarName) {
        envVars[provider.envVarName] = getEnvVar(provider.envVarName);
      }
    }
    return envVars;
  });

  createTypedHandler(appContracts.editAppFile, async (_, params) => {
    let { appId, filePath, content } = params;
    // It should already be normalized, but just in case.
    filePath = normalizePath(filePath);
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
    const fullPath = path.join(appPath, filePath);

    // Check if the path is within the app directory (security check)
    if (!fullPath.startsWith(appPath)) {
      throw new OrianBuilderError(
        "Invalid file path",
        OrianBuilderErrorKind.Validation,
      );
    }

    if (app.neonProjectId && app.neonDevelopmentBranchId) {
      try {
        await storeDbTimestampAtCurrentVersion({
          appId: app.id,
        });
      } catch (error) {
        logger.error("Error storing Neon timestamp at current version:", error);
        throw new Error(
          "Could not store Neon timestamp at current version; database versioning functionality is not working: " +
            error,
        );
      }
    }

    // Ensure directory exists
    const dirPath = path.dirname(fullPath);
    await fsPromises.mkdir(dirPath, { recursive: true });

    try {
      await fsPromises.writeFile(fullPath, content, "utf-8");

      // Check if git repository exists and commit the change
      if (fs.existsSync(path.join(appPath, ".git"))) {
        await gitAdd({ path: appPath, filepath: filePath });

        await gitCommit({
          path: appPath,
          message: `Updated ${filePath}`,
        });
      }
    } catch (error: any) {
      logger.error(`Error writing file ${filePath} for app ${appId}:`, error);
      throw new OrianBuilderError(
        `Failed to write file: ${error.message}`,
        OrianBuilderErrorKind.External,
      );
    }

    queueCloudSandboxSnapshotSync({
      appId,
      changedPaths: [filePath],
    });

    if (app.supabaseProjectId) {
      // Check if shared module was modified - redeploy all functions
      if (isSharedServerModule(filePath)) {
        try {
          logger.info(
            `Shared module ${filePath} modified, redeploying all Supabase functions`,
          );
          const settings = readSettings();
          const deployErrors = await deployAllSupabaseFunctions({
            appPath,
            supabaseProjectId: app.supabaseProjectId,
            supabaseOrganizationSlug: app.supabaseOrganizationSlug ?? null,
            skipPruneEdgeFunctions: settings.skipPruneEdgeFunctions ?? false,
          });
          if (deployErrors.length > 0) {
            return {
              warning: `File saved, but some Supabase functions failed to deploy: ${deployErrors.join(", ")}`,
            };
          }
        } catch (error) {
          logger.error(
            `Error redeploying Supabase functions after shared module change:`,
            error,
          );
          return {
            warning: `File saved, but failed to redeploy Supabase functions: ${error}`,
          };
        }
      } else if (isServerFunction(filePath)) {
        // Regular function file - deploy just this function
        try {
          const functionName = extractFunctionNameFromPath(filePath);
          await deploySupabaseFunction({
            supabaseProjectId: app.supabaseProjectId,
            functionName,
            appPath,
            organizationSlug: app.supabaseOrganizationSlug ?? null,
          });
        } catch (error) {
          logger.error(`Error deploying Supabase function ${filePath}:`, error);
          return {
            warning: `File saved, but failed to deploy Supabase function: ${filePath}: ${error}`,
          };
        }
      }
    }

    return {};
  });

  createTypedHandler(appContracts.deleteApp, async (_, params) => {
    const { appId } = params;
    // Static server worker is NOT terminated here anymore

    return withLock(appId, async () => {
      // Check if app exists
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, appId),
      });

      if (!app) {
        throw new OrianBuilderError(
          "App not found",
          OrianBuilderErrorKind.NotFound,
        );
      }

      // Stop the app if it's running
      if (runningApps.has(appId)) {
        const appInfo = runningApps.get(appId)!;
        try {
          logger.log(`Stopping app ${appId} before deletion.`); // Adjusted log
          await stopAppByInfo(appId, appInfo);
        } catch (error: any) {
          logger.error(`Error stopping app ${appId} before deletion:`, error); // Adjusted log
          // Continue with deletion even if stopping fails
        }
      }

      // Clear logs for this app to prevent memory leak
      clearLogs(appId);

      // Delete app from database
      try {
        await db.delete(apps).where(eq(apps.id, appId));
        // Note: Associated chats will cascade delete
      } catch (error: any) {
        logger.error(`Error deleting app ${appId} from database:`, error);
        throw new OrianBuilderError(
          `Failed to delete app from database: ${error.message}`,
          OrianBuilderErrorKind.External,
        );
      }

      // Delete app files
      const appPath = getOrianBuilderAppPath(app.path);
      try {
        await fsPromises.rm(appPath, { recursive: true, force: true });
      } catch (error: any) {
        logger.error(`Error deleting app files for app ${appId}:`, error);
        throw new Error(
          `App deleted from database, but failed to delete app files. Please delete app files from ${appPath} manually.\n\nError: ${error.message}`,
        );
      }
    });
  });

  createTypedHandler(appContracts.addToFavorite, async (_, params) => {
    const { appId } = params;
    return withLock(appId, async () => {
      try {
        // Fetch the current isFavorite value
        const result = await db
          .select({ isFavorite: apps.isFavorite })
          .from(apps)
          .where(eq(apps.id, appId))
          .limit(1);

        if (result.length === 0) {
          throw new OrianBuilderError(
            `App with ID ${appId} not found.`,
            OrianBuilderErrorKind.NotFound,
          );
        }

        const currentIsFavorite = result[0].isFavorite;

        // Toggle the isFavorite value
        const updated = await db
          .update(apps)
          .set({ isFavorite: !currentIsFavorite })
          .where(eq(apps.id, appId))
          .returning({ isFavorite: apps.isFavorite });

        if (updated.length === 0) {
          throw new Error(
            `Failed to update favorite status for app ID ${appId}.`,
          );
        }

        // Return the updated isFavorite value
        return { isFavorite: updated[0].isFavorite };
      } catch (error: any) {
        logger.error(
          `Error in add-to-favorite handler for app ID ${appId}:`,
          error,
        );
        throw new OrianBuilderError(
          `Failed to toggle favorite status: ${error.message}`,
          OrianBuilderErrorKind.External,
        );
      }
    });
  });

  createTypedHandler(appContracts.renameApp, async (_, params) => {
    const { appId, appName, appPath: newPath } = params;
    return withLock(appId, async () => {
      let appPath = newPath;
      // Check if app exists
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, appId),
      });

      if (!app) {
        throw new OrianBuilderError(
          "App not found",
          OrianBuilderErrorKind.NotFound,
        );
      }

      const pathChanged = appPath !== app.path;

      // Security: reject NEW absolute paths - rename-app should only accept relative paths for new paths
      // Absolute paths should only be set through change-app-location handler
      // If the path is changing and it's absolute, reject it
      if (pathChanged && path.isAbsolute(appPath)) {
        throw new Error(
          "Absolute paths are not allowed when renaming an app folder. Please use a relative folder name only. To change the storage location, use the 'Change location' button.",
        );
      }

      // Validate path for invalid characters when path changes (only for relative paths)
      if (pathChanged) {
        const invalidChars = /[<>:"|?*/\\]/;
        const hasInvalidChars =
          invalidChars.test(appPath) || /[\x00-\x1f]/.test(appPath);

        if (hasInvalidChars) {
          throw new Error(
            `App path "${appPath}" contains characters that are not allowed in folder names: < > : " | ? * / \\ or control characters. Please use a different path.`,
          );
        }
      }

      // Check for conflicts with existing apps
      const nameConflict = await db.query.apps.findFirst({
        where: eq(apps.name, appName),
      });

      if (nameConflict && nameConflict.id !== appId) {
        throw new OrianBuilderError(
          `An app with the name '${appName}' already exists`,
          OrianBuilderErrorKind.Conflict,
        );
      }

      // If the current path is absolute, preserve the directory and only change the folder name
      // Otherwise, resolve the new path using the default base path
      const currentResolvedPath = getOrianBuilderAppPath(app.path);
      const newAppPath = path.isAbsolute(app.path)
        ? path.join(path.dirname(app.path), appPath)
        : getOrianBuilderAppPath(appPath);

      let hasPathConflict = false;
      if (pathChanged) {
        const allApps = await db.query.apps.findMany();
        hasPathConflict = allApps.some((existingApp) => {
          if (existingApp.id === appId) {
            return false;
          }
          return getOrianBuilderAppPath(existingApp.path) === newAppPath;
        });
      }

      if (hasPathConflict) {
        throw new OrianBuilderError(
          `An app with the path '${newAppPath}' already exists`,
          OrianBuilderErrorKind.Conflict,
        );
      }

      // Stop the app if it's running
      if (runningApps.has(appId)) {
        const appInfo = runningApps.get(appId)!;
        try {
          await stopAppByInfo(appId, appInfo);
        } catch (error: any) {
          logger.error(`Error stopping app ${appId} before renaming:`, error);
          throw new Error(
            `Failed to stop app before renaming: ${error.message}`,
          );
        }
      }

      const oldAppPath = currentResolvedPath;
      // Only move files if needed
      if (newAppPath !== oldAppPath) {
        // Move app files
        try {
          // Check if destination directory already exists
          if (fs.existsSync(newAppPath)) {
            throw new OrianBuilderError(
              `Destination path '${newAppPath}' already exists`,
              OrianBuilderErrorKind.Conflict,
            );
          }

          // Create parent directory if it doesn't exist
          await fsPromises.mkdir(path.dirname(newAppPath), {
            recursive: true,
          });

          // Copy the directory without node_modules
          await copyDir(oldAppPath, newAppPath, undefined, {
            excludeNodeModules: true,
          });
        } catch (error: any) {
          logger.error(
            `Error moving app files from ${oldAppPath} to ${newAppPath}:`,
            error,
          );
          // Attempt cleanup if destination exists (partial copy may have occurred)
          if (fs.existsSync(newAppPath)) {
            try {
              await fsPromises.rm(newAppPath, {
                recursive: true,
                force: true,
              });
            } catch (cleanupError) {
              logger.warn(
                `Failed to clean up partial move at ${newAppPath}:`,
                cleanupError,
              );
            }
          }
          throw new OrianBuilderError(
            `Failed to move app files: ${error.message}`,
            OrianBuilderErrorKind.External,
          );
        }

        try {
          // Delete the old directory
          await fsPromises.rm(oldAppPath, { recursive: true, force: true });
        } catch (error: any) {
          // Why is this just a warning? This happens quite often on Windows
          // because it has an aggressive file lock.
          //
          // Not deleting the old directory is annoying, but not a big deal
          // since the user can do it themselves if they need to.
          logger.warn(`Error deleting old app directory ${oldAppPath}:`, error);
        }
      }

      // Update app in database
      // If the current path was absolute, store the new absolute path; otherwise store the relative path
      const pathToStore = path.isAbsolute(app.path) ? newAppPath : appPath;
      try {
        await db
          .update(apps)
          .set({
            name: appName,
            path: pathToStore,
          })
          .where(eq(apps.id, appId))
          .returning();

        return;
      } catch (error: any) {
        // Attempt to rollback the file move
        if (newAppPath !== oldAppPath) {
          try {
            // Copy back from new to old
            await copyDir(newAppPath, oldAppPath, undefined, {
              excludeNodeModules: true,
            });
            // Delete the new directory
            await fsPromises.rm(newAppPath, { recursive: true, force: true });
          } catch (rollbackError) {
            logger.error(
              `Failed to rollback file move during rename error:`,
              rollbackError,
            );
          }
        }

        logger.error(`Error updating app ${appId} in database:`, error);
        throw new OrianBuilderError(
          `Failed to update app in database: ${error.message}`,
          OrianBuilderErrorKind.External,
        );
      }
    });
  });

  createTypedHandler(systemContracts.resetAll, async () => {
    logger.log("start: resetting all apps and settings.");
    // Stop all running apps first
    logger.log("stopping all running apps...");
    const runningAppIds = Array.from(runningApps.keys());
    for (const appId of runningAppIds) {
      try {
        const appInfo = runningApps.get(appId)!;
        await stopAppByInfo(appId, appInfo);
      } catch (error) {
        logger.error(`Error stopping app ${appId} during reset:`, error);
        // Continue with reset even if stopping fails
      }
    }
    logger.log("all running apps stopped.");
    // Determine the paths of all apps in the database so that we can delete them.
    // We do the deletion last, so technically this is a TOCTOU race, but
    // it allows us to do the deletion last after removing the database
    const allAppPaths = await db.select({ appPath: apps.path }).from(apps);
    // To resolve app paths later
    const basePath = getOrianBuilderAppsBaseDirectory();
    logger.log("deleting database...");
    // 1. Drop the database by deleting the SQLite file
    const dbPath = getDatabasePath();
    if (fs.existsSync(dbPath)) {
      // Close database connections first
      if (db.$client) {
        db.$client.close();
      }
      await fsPromises.unlink(dbPath);
      logger.log(`Database file deleted: ${dbPath}`);
    }
    logger.log("database deleted.");
    logger.log("deleting settings...");
    // 2. Remove settings
    const userDataPath = getUserDataPath();
    const settingsPath = path.join(userDataPath, "user-settings.json");

    if (fs.existsSync(settingsPath)) {
      await fsPromises.unlink(settingsPath);
      logger.log(`Settings file deleted: ${settingsPath}`);
    }
    // Reset base directory cache to default, because settings are gone anyway
    invalidateOrianBuilderAppsBaseDirectoryCache();
    logger.log("settings deleted.");
    // 3. Remove all app files recursively
    // Doing this last because it's the most time-consuming and the least important
    // in terms of resetting the app state.
    logger.log("removing all app files...");
    // Delete any app paths that were in the database before we deleted it
    for (const { appPath } of allAppPaths) {
      // We don't rely on getOrianBuilderAppPath here because we've already cleared the settings
      const resolvedAppPath = path.isAbsolute(appPath)
        ? appPath
        : path.join(basePath, appPath);
      await fsPromises.rm(resolvedAppPath, {
        recursive: true,
        force: true,
      });
    }
    const orianbuilderAppPath = getDefaultOrianBuilderAppsDirectory();
    // Delete the default `orianbuilder-apps` folder, even if the user no longer uses it
    if (fs.existsSync(orianbuilderAppPath)) {
      await fsPromises.rm(orianbuilderAppPath, {
        recursive: true,
        force: true,
      });
      // Recreate the base directory
      await fsPromises.mkdir(orianbuilderAppPath, { recursive: true });
    }
    logger.log("all app files removed.");
    logger.log("reset all complete.");
  });

  createTypedHandler(systemContracts.getAppVersion, async () => {
    // Read version from package.json at project root
    const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    return { version: packageJson.version };
  });

  createTypedHandler(appContracts.searchAppFiles, async (_, params) => {
    const { appId, query } = params;
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return [];
    }

    const appRecord = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
    });

    if (!appRecord) {
      throw new OrianBuilderError(
        "App not found",
        OrianBuilderErrorKind.NotFound,
      );
    }

    const appPath = getOrianBuilderAppPath(appRecord.path);

    // Search file contents with ripgrep
    const contentMatches = await searchAppFilesWithRipgrep({
      appPath,
      query: trimmedQuery,
    });

    return contentMatches;
  });

  // search-app is not in app contracts - keep using handle

  handle(
    "search-app",
    async (_, searchQuery: string): Promise<AppSearchResult[]> => {
      // Use parameterized query to prevent SQL injection
      const pattern = `%${searchQuery.replace(/[%_]/g, "\\$&")}%`;

      // 1) Apps whose name matches
      const appNameMatches = await db
        .select({
          id: apps.id,
          name: apps.name,
          createdAt: apps.createdAt,
        })
        .from(apps)
        .where(like(apps.name, pattern))
        .orderBy(desc(apps.createdAt));

      const appNameMatchesResult: AppSearchResult[] = appNameMatches.map(
        (r) => ({
          id: r.id,
          name: r.name,
          createdAt: r.createdAt,
          matchedChatTitle: null,
          matchedChatMessage: null,
        }),
      );

      // 2) Apps whose chat title matches
      const chatTitleMatches = await db
        .select({
          id: apps.id,
          name: apps.name,
          createdAt: apps.createdAt,
          matchedChatTitle: chats.title,
        })
        .from(apps)
        .innerJoin(chats, eq(apps.id, chats.appId))
        .where(like(chats.title, pattern))
        .orderBy(desc(apps.createdAt));

      const chatTitleMatchesResult: AppSearchResult[] = chatTitleMatches.map(
        (r) => ({
          id: r.id,
          name: r.name,
          createdAt: r.createdAt,
          matchedChatTitle: r.matchedChatTitle,
          matchedChatMessage: null,
        }),
      );

      // 3) Apps whose chat message content matches
      const chatMessageMatches = await db
        .select({
          id: apps.id,
          name: apps.name,
          createdAt: apps.createdAt,
          matchedChatTitle: chats.title,
          matchedChatMessage: messages.content,
        })
        .from(apps)
        .innerJoin(chats, eq(apps.id, chats.appId))
        .innerJoin(messages, eq(chats.id, messages.chatId))
        .where(like(messages.content, pattern))
        .orderBy(desc(apps.createdAt));

      // Flatten and dedupe by app id
      const allMatches: AppSearchResult[] = [
        ...appNameMatchesResult,
        ...chatTitleMatchesResult,
        ...chatMessageMatches,
      ];
      const uniqueApps = Array.from(
        new Map(allMatches.map((app) => [app.id, app])).values(),
      );

      // Sort newest apps first
      uniqueApps.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      return uniqueApps;
    },
  );

  // Handler for adding logs to central store from renderer

  handle(
    "select-app-location",
    async (
      _,
      { defaultPath }: { defaultPath?: string },
    ): Promise<{ path: string | null; canceled: boolean }> => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: "Select a folder where this app will be stored",
        defaultPath,
      });

      if (result.canceled || !result.filePaths[0]) {
        return { path: null, canceled: true };
      }

      return { path: result.filePaths[0], canceled: false };
    },
  );

  createTypedHandler(appContracts.changeAppLocation, async (_, params) => {
    const { appId, parentDirectory } = params;

    if (!parentDirectory) {
      throw new OrianBuilderError(
        "No destination folder provided.",
        OrianBuilderErrorKind.External,
      );
    }

    if (!path.isAbsolute(parentDirectory)) {
      throw new OrianBuilderError(
        "Please select an absolute destination folder.",
        OrianBuilderErrorKind.External,
      );
    }

    const normalizedParentDir = path.normalize(parentDirectory);

    return withLock(appId, async () => {
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, appId),
      });

      if (!app) {
        throw new OrianBuilderError(
          "App not found",
          OrianBuilderErrorKind.NotFound,
        );
      }

      const currentResolvedPath = getOrianBuilderAppPath(app.path);
      // Extract app folder name from current path (works for both absolute and relative paths)
      const appFolderName = path.basename(
        path.isAbsolute(app.path) ? app.path : currentResolvedPath,
      );
      const nextResolvedPath = path.join(normalizedParentDir, appFolderName);

      if (currentResolvedPath === nextResolvedPath) {
        // Path hasn't changed, but we should update to absolute path format if needed
        if (!path.isAbsolute(app.path)) {
          await db
            .update(apps)
            .set({ path: nextResolvedPath })
            .where(eq(apps.id, appId));
        }
        return {
          resolvedPath: nextResolvedPath,
        };
      }

      const allApps = await db.query.apps.findMany();
      const conflict = allApps.some(
        (existingApp) =>
          existingApp.id !== appId &&
          getOrianBuilderAppPath(existingApp.path) === nextResolvedPath,
      );

      if (conflict) {
        throw new Error(
          `Another app already exists at '${nextResolvedPath}'. Please choose a different folder.`,
        );
      }

      if (fs.existsSync(nextResolvedPath)) {
        throw new Error(
          `Destination path '${nextResolvedPath}' already exists. Please choose an empty folder.`,
        );
      }

      // Check if source path exists - if not, just update the DB path without copying
      const sourceExists = fs.existsSync(currentResolvedPath);
      if (!sourceExists) {
        logger.warn(
          `Source path ${currentResolvedPath} does not exist. Updating database path only.`,
        );
        await db
          .update(apps)
          .set({ path: nextResolvedPath })
          .where(eq(apps.id, appId));
        return {
          resolvedPath: nextResolvedPath,
        };
      }

      if (runningApps.has(appId)) {
        const appInfo = runningApps.get(appId)!;
        try {
          await stopAppByInfo(appId, appInfo);
        } catch (error: any) {
          logger.error(`Error stopping app ${appId} before moving:`, error);
          throw new OrianBuilderError(
            `Failed to stop app before moving: ${error.message}`,
            OrianBuilderErrorKind.External,
          );
        }
      }

      await fsPromises.mkdir(normalizedParentDir, { recursive: true });

      try {
        // Copy the directory without node_modules
        await copyDir(currentResolvedPath, nextResolvedPath, undefined, {
          excludeNodeModules: true,
        });

        // Update path to absolute path
        await db
          .update(apps)
          .set({ path: nextResolvedPath })
          .where(eq(apps.id, appId));

        try {
          await fsPromises.rm(currentResolvedPath, {
            recursive: true,
            force: true,
          });
        } catch (error: any) {
          logger.warn(
            `Error deleting old app directory ${currentResolvedPath}:`,
            error,
          );
        }

        return {
          resolvedPath: nextResolvedPath,
        };
      } catch (error: any) {
        // Attempt cleanup if destination exists (partial copy may have occurred)
        if (fs.existsSync(nextResolvedPath)) {
          try {
            await fsPromises.rm(nextResolvedPath, {
              recursive: true,
              force: true,
            });
          } catch (cleanupError) {
            logger.warn(
              `Failed to clean up partial move at ${nextResolvedPath}:`,
              cleanupError,
            );
          }
        }
        logger.error(
          `Error moving app files from ${currentResolvedPath} to ${nextResolvedPath}:`,
          error,
        );
        throw new OrianBuilderError(
          `Failed to move app files: ${error.message}`,
          OrianBuilderErrorKind.External,
        );
      }
    });
  });

  // Handler for selecting an app for preview (updates lastViewedAt to prevent GC)

  createTypedHandler(appContracts.exportAppZip, async (_, params) => {
    const { appId, destinationPath } = params;
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
    return exportProjectZip(appPath, destinationPath);
  });

  createTypedHandler(
    appContracts.pickExportZipDestination,
    async (_, params) => {
      const result = await dialog.showSaveDialog({
        title: "Export project as ZIP",
        defaultPath: params.suggestedName,
        filters: [{ name: "Zip Archive", extensions: ["zip"] }],
      });
      return {
        canceled: result.canceled,
        path: result.canceled ? null : (result.filePath ?? null),
      };
    },
  );
}
