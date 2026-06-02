/**
 * IPC for the global generated-media store (see main/generated_media/store.ts).
 * Backs the unified Library → Media view and is the source for publishing and
 * peer sharing.
 */
import { BrowserWindow } from "electron";
import { generatedMediaContracts, generatedMediaEvents } from "@/ipc/types/generated_media";
import { createTypedHandler } from "./base";
import * as store from "@/main/generated_media/store";
import { mediaShare } from "@/main/network/media-share";

function emitChanged(): void {
  const count = store.list().length;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(generatedMediaEvents.changed.channel, { count });
    }
  }
}

export function registerGeneratedMediaHandlers(): void {
  createTypedHandler(generatedMediaContracts.list, async () => store.list());

  createTypedHandler(generatedMediaContracts.saveFromUrl, async (_e, params) => {
    const item = await store.saveFromUrl(params.url, {
      prompt: params.prompt ?? null,
      promptOrStem: params.prompt ?? undefined,
      ext: params.ext,
    });
    emitChanged();
    return item;
  });

  createTypedHandler(generatedMediaContracts.remove, async (_e, { fileName }) => {
    store.remove(fileName);
    emitChanged();
    // A removed item may have been shared — re-announce the smaller set.
    mediaShare.announceToAll();
    return { ok: true };
  });

  createTypedHandler(
    generatedMediaContracts.setShared,
    async (_e, { fileName, shared }) => {
      store.setShared(fileName, shared);
      emitChanged();
      // Broadcast the updated sharable set to trusted peers.
      mediaShare.announceToAll();
      return { ok: true };
    },
  );

  createTypedHandler(
    generatedMediaContracts.setThumbnail,
    async (_e, { fileName, thumbnail }) => {
      store.setThumbnail(fileName, thumbnail);
      return { ok: true };
    },
  );
}
