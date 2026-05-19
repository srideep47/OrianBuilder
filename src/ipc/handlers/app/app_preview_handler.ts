import { db } from "../../../db";
import { apps } from "../../../db/schema";
import { eq, inArray } from "drizzle-orm";
import { createTypedHandler } from "../base";
import { appContracts } from "../../types/app";
import path from "node:path";
import { getOrianBuilderAppPath } from "../../../paths/paths";
import { promises as fsPromises } from "node:fs";
import {
  runningApps,
  setCurrentlySelectedAppId,
} from "../../utils/process_manager";
import {
  ORIANBUILDER_SCREENSHOT_DIR_NAME,
  MAX_SCREENSHOTS_PER_APP,
  SCREENSHOT_FILENAME_REGEX,
} from "../../utils/media_path_utils";
import {
  createCloudSandboxShareLink,
  getCloudSandboxStatus,
} from "../../utils/cloud_sandbox_provider";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import {
  formatCloudSandboxError,
  logger,
  readScreenshotEntries,
  ensureProxyForRunningApp,
} from "./app_shared";
/**
 * App preview, cloud sandbox, and screenshot IPC handlers.
 */

export function registerAppPreviewHandlers() {
  createTypedHandler(
    appContracts.getCloudSandboxStatus,
    async (event, params) => {
      const { appId } = params;
      const appInfo = runningApps.get(appId);

      if (!appInfo || appInfo.mode !== "cloud" || !appInfo.cloudSandboxId) {
        return null;
      }

      try {
        const status = await getCloudSandboxStatus(appInfo.cloudSandboxId);
        const previewChanged =
          appInfo.cloudPreviewUrl !== status.previewUrl ||
          appInfo.cloudPreviewAuthToken !== status.previewAuthToken;
        appInfo.cloudPreviewUrl = status.previewUrl;
        appInfo.cloudPreviewAuthToken = status.previewAuthToken;

        if (previewChanged && appInfo.proxyWorker) {
          await ensureProxyForRunningApp({
            appId,
            event,
            originalUrl: status.previewUrl,
            mode: "cloud",
          });
        } else {
          appInfo.originalUrl = status.previewUrl;
        }

        return {
          ...status,
          localSyncErrorMessage: appInfo.cloudSyncErrorMessage ?? null,
        };
      } catch (error) {
        logger.error(
          `Failed to fetch cloud sandbox status for app ${appId}:`,
          error,
        );
        throw new OrianBuilderError(
          formatCloudSandboxError(error),
          OrianBuilderErrorKind.External,
        );
      }
    },
  );

  createTypedHandler(
    appContracts.createCloudSandboxShareLink,
    async (_, params) => {
      const { appId, expiresInSeconds } = params;
      const appInfo = runningApps.get(appId);

      if (!appInfo || appInfo.mode !== "cloud" || !appInfo.cloudSandboxId) {
        throw new OrianBuilderError(
          `App ${appId} is not running in cloud mode`,
          OrianBuilderErrorKind.External,
        );
      }

      try {
        return await createCloudSandboxShareLink(appInfo.cloudSandboxId, {
          expiresInSeconds,
        });
      } catch (error) {
        logger.error(
          `Failed to create cloud sandbox share link for app ${appId}:`,
          error,
        );
        throw new OrianBuilderError(
          formatCloudSandboxError(error),
          OrianBuilderErrorKind.External,
        );
      }
    },
  );

  createTypedHandler(appContracts.selectAppForPreview, async (_, params) => {
    const { appId } = params;
    if (appId !== null) {
      logger.debug(`App ${appId} selected for preview`);
      setCurrentlySelectedAppId(appId);
    } else {
      logger.debug("No app selected for preview");
      setCurrentlySelectedAppId(null);
    }
  });

  // Screenshot handlers

  createTypedHandler(appContracts.saveAppScreenshot, async (_, params) => {
    const { appId, dataUrl, commitHash } = params;

    // Validate data URL format
    if (!/^data:image\/(png|jpe?g|webp);base64,/.test(dataUrl)) {
      throw new OrianBuilderError(
        "Invalid screenshot data URL format",
        OrianBuilderErrorKind.Validation,
      );
    }

    // Enforce a max size of 5 MB
    const MAX_DATA_URL_LENGTH = 5 * 1024 * 1024;
    if (dataUrl.length > MAX_DATA_URL_LENGTH) {
      throw new OrianBuilderError(
        "Screenshot data URL exceeds maximum allowed size",
        OrianBuilderErrorKind.Validation,
      );
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

    if (!SCREENSHOT_FILENAME_REGEX.test(`${commitHash}.png`)) {
      logger.warn(
        `Skipping screenshot save for app ${appId}: unexpected commit hash format`,
      );
      return;
    }

    const screenshotDir = path.join(appPath, ORIANBUILDER_SCREENSHOT_DIR_NAME);
    await fsPromises.mkdir(screenshotDir, { recursive: true });

    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");
    await fsPromises.writeFile(
      path.join(screenshotDir, `${commitHash}.png`),
      buffer,
    );

    // Prune: keep only the newest MAX_SCREENSHOTS_PER_APP by mtime.
    // Swallow ENOENT on unlink to tolerate concurrent saves.
    try {
      const screenshots = await readScreenshotEntries(screenshotDir);
      for (const extra of screenshots.slice(MAX_SCREENSHOTS_PER_APP)) {
        await fsPromises
          .unlink(path.join(screenshotDir, extra.name))
          .catch(() => {});
      }
    } catch (err) {
      logger.warn(`Failed to prune screenshots for app ${appId}`, err);
    }
  });

  createTypedHandler(appContracts.listAppScreenshots, async (_, params) => {
    const { appId } = params;

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
    const screenshotDir = path.join(appPath, ORIANBUILDER_SCREENSHOT_DIR_NAME);

    const entries = await readScreenshotEntries(screenshotDir);
    const screenshots = entries.map(({ name }) => ({
      commitHash: name.slice(0, -".png".length),
      url: `orian-media://media/${encodeURIComponent(appRecord.path)}/${ORIANBUILDER_SCREENSHOT_DIR_NAME}/${name}`,
    }));
    return { screenshots };
  });

  createTypedHandler(appContracts.listAppThumbnails, async (_, params) => {
    const { appIds } = params;
    if (appIds.length === 0) {
      return { thumbnails: [] };
    }

    const records = await db.query.apps.findMany({
      where: inArray(apps.id, appIds),
    });
    const recordById = new Map(records.map((r) => [r.id, r]));

    const thumbnails = await Promise.all(
      appIds.map(async (appId) => {
        const record = recordById.get(appId);
        if (!record) {
          return { appId, thumbnailUrl: null };
        }
        const appPath = getOrianBuilderAppPath(record.path);
        const screenshotDir = path.join(
          appPath,
          ORIANBUILDER_SCREENSHOT_DIR_NAME,
        );
        const entries = await readScreenshotEntries(screenshotDir);
        const latest = entries[0];
        if (!latest) {
          return { appId, thumbnailUrl: null };
        }
        const thumbnailUrl = `orian-media://media/${encodeURIComponent(record.path)}/${ORIANBUILDER_SCREENSHOT_DIR_NAME}/${latest.name}`;
        return { appId, thumbnailUrl };
      }),
    );

    return { thumbnails };
  });
}
