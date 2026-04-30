import { BrowserWindow } from "electron";
import log from "electron-log";
import { createTypedHandler } from "./base";
import {
  modelMarketplaceContracts,
  modelMarketplaceEvents,
} from "../types/model_marketplace";
import {
  searchModels,
  getModelDetail,
  resolveFileUrl,
} from "../utils/huggingface_client";
import {
  startDownload,
  cancelDownload,
  listDownloads,
  clearCompleted,
  listLocalModels,
  deleteLocalModel,
  getModelsDirInfo,
} from "../utils/model_download_manager";
import { readGgufMetadata } from "../utils/gguf_metadata";
import { readSettings } from "../../main/settings";

const logger = log.scope("marketplace-handler");

function broadcastDownloadProgress(progress: any) {
  const channel = modelMarketplaceEvents.downloadProgress.channel;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, progress);
  }
}

function getHfToken(): string | undefined {
  try {
    const s = readSettings() as any;
    return (
      s?.providerSettings?.huggingface?.apiKey?.value ??
      s?.huggingFaceToken ??
      process.env.HF_TOKEN ??
      process.env.HUGGING_FACE_HUB_TOKEN
    );
  } catch {
    return undefined;
  }
}

export function registerMarketplaceHandlers(): void {
  createTypedHandler(
    modelMarketplaceContracts.searchModels,
    async (_event, input) => {
      return searchModels({ ...input, authToken: getHfToken() });
    },
  );

  createTypedHandler(
    modelMarketplaceContracts.getModelDetail,
    async (_event, { repoId }) => {
      return getModelDetail(repoId, { authToken: getHfToken() });
    },
  );

  createTypedHandler(
    modelMarketplaceContracts.startDownload,
    async (_event, input) => {
      try {
        const url = resolveFileUrl(input.repoId, input.fileName);
        const dl = await startDownload({
          url,
          repoId: input.repoId,
          fileName: input.fileName,
          authToken: getHfToken(),
          parallelConnections: input.parallelConnections,
          onUpdate: broadcastDownloadProgress,
        });
        return { success: true, download: dl };
      } catch (err: any) {
        logger.error("startDownload failed:", err);
        return { success: false, error: err?.message ?? String(err) };
      }
    },
  );

  createTypedHandler(
    modelMarketplaceContracts.cancelDownload,
    async (_event, { id }) => {
      return { success: cancelDownload(id) };
    },
  );

  createTypedHandler(modelMarketplaceContracts.listDownloads, async () => {
    return listDownloads();
  });

  createTypedHandler(
    modelMarketplaceContracts.clearCompletedDownloads,
    async () => {
      return { removed: clearCompleted() };
    },
  );

  createTypedHandler(modelMarketplaceContracts.listLocalModels, async () => {
    return listLocalModels();
  });

  createTypedHandler(
    modelMarketplaceContracts.deleteLocalModel,
    async (_event, { filePath }) => {
      return deleteLocalModel(filePath);
    },
  );

  createTypedHandler(modelMarketplaceContracts.getModelsDirInfo, async () => {
    return getModelsDirInfo();
  });

  createTypedHandler(
    modelMarketplaceContracts.readGgufMetadata,
    async (_event, { filePath }) => {
      return readGgufMetadata(filePath);
    },
  );
}
