/**
 * IPC for browsing and downloading media shared by trusted peers over the P2P
 * network. The heavy lifting lives in main/network/media-share.ts.
 */
import { sharedMediaContracts } from "@/ipc/types/shared_media";
import { createTypedHandler } from "./base";
import { mediaShare } from "@/main/network/media-share";

export function registerSharedMediaHandlers(): void {
  createTypedHandler(sharedMediaContracts.getCatalog, async () =>
    mediaShare.getCatalog(),
  );

  createTypedHandler(sharedMediaContracts.refresh, async () => {
    mediaShare.requestRefresh();
    return { ok: true };
  });

  createTypedHandler(
    sharedMediaContracts.download,
    async (_e, { peerKey, fileName }) => {
      return mediaShare.requestDownload(peerKey, fileName);
    },
  );

  createTypedHandler(sharedMediaContracts.pushAsset, async (_e, input) =>
    mediaShare.offerAsset(input),
  );

  createTypedHandler(sharedMediaContracts.respondToPush, async (_e, input) =>
    mediaShare.respondToPush(input),
  );

  createTypedHandler(sharedMediaContracts.pendingPushOffers, async () =>
    mediaShare.pendingPushOffers(),
  );
}
