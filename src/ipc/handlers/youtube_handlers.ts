/**
 * IPC for publishing generated-media videos to YouTube.
 *
 * Auth state + tokens live in main/publish/youtube-store.ts; the OAuth flow and
 * upload logic live alongside it. These handlers are a thin bridge from the
 * renderer. Credentials/tokens never cross the IPC boundary — only status.
 */
import { BrowserWindow } from "electron";
import log from "electron-log";
import { youtubeContracts, youtubeEvents } from "@/ipc/types/youtube";
import { createTypedHandler } from "./base";
import * as ytStore from "@/main/publish/youtube-store";
import { runOAuthFlow } from "@/main/publish/youtube-oauth";
import { publishVideo } from "@/main/publish/youtube-publish";

const logger = log.scope("youtube_handlers");

function emitProgress(fileName: string, percent: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(youtubeEvents.publishProgress.channel, {
        fileName,
        percent,
      });
    }
  }
}

export function registerYouTubeHandlers(): void {
  createTypedHandler(youtubeContracts.getStatus, async () => ytStore.getStatus());

  // DO NOT LOG — carries the client secret.
  createTypedHandler(
    youtubeContracts.saveCredentials,
    async (_e, { clientId, clientSecret }) => {
      ytStore.saveCredentials(clientId, clientSecret);
      return ytStore.getStatus();
    },
  );

  createTypedHandler(youtubeContracts.connect, async () => {
    await runOAuthFlow();
    return ytStore.getStatus();
  });

  createTypedHandler(youtubeContracts.disconnect, async () => {
    ytStore.clearAll();
    return ytStore.getStatus();
  });

  createTypedHandler(youtubeContracts.publish, async (_e, params) => {
    logger.info(`Publishing ${params.fileName} to YouTube (${params.privacy})`);
    return publishVideo({
      fileName: params.fileName,
      title: params.title,
      description: params.description,
      privacy: params.privacy,
      tags: params.tags,
      onProgress: (percent) => emitProgress(params.fileName, percent),
    });
  });

  logger.debug("Registered YouTube IPC handlers");
}
