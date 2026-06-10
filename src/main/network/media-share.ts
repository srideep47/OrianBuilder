/**
 * Peer-to-peer media sharing coordinator.
 *
 * - Announces the local user's "sharable" media to trusted peers.
 * - Tracks each peer's advertised catalog (in memory).
 * - Serves file bytes (chunked, base64) on request.
 * - Downloads a requested file, reassembles it, and saves it to the local
 *   generated-media store (where it becomes a normal library item).
 *
 * The swarm owns the sockets; it injects a small bridge here and delegates
 * MEDIA_* messages to `handleMessage`. This keeps swarm.ts free of media logic.
 */
import { BrowserWindow } from "electron";
import log from "electron-log/main";
import type { ChannelMessage, SharedMediaMeta } from "./peer-channel";
import * as store from "@/main/generated_media/store";
import {
  sharedMediaEvents,
  type SharedPeerCatalog,
} from "@/ipc/types/shared_media";

const logger = log.scope("media-share");

const CHUNK_SIZE = 64 * 1024; // 64 KB

export interface MediaShareBridge {
  /** Send a message to every connected, trusted peer. */
  broadcastToTrusted(msg: ChannelMessage): void;
  /** Send a message to one peer by public-key hex. Returns false if not connected. */
  sendToPeer(peerKey: string, msg: ChannelMessage): boolean;
  /** Display name for a connected peer, if known. */
  getDisplayName(peerKey: string): string | null;
}

interface PendingDownload {
  peerKey: string;
  meta: SharedMediaMeta;
  chunks: Buffer[];
  received: number;
}

class MediaShare {
  private bridge: MediaShareBridge | null = null;
  /** peerKey → { displayName, items } */
  private remoteCatalogs = new Map<string, SharedPeerCatalog>();
  /** requestId → in-flight download */
  private pending = new Map<string, PendingDownload>();
  private reqCounter = 0;

  init(bridge: MediaShareBridge): void {
    this.bridge = bridge;
  }

  // ── Renderer notifications ────────────────────────────────────────────────
  private broadcastToRenderer(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  private emitCatalogChanged(): void {
    this.broadcastToRenderer(sharedMediaEvents.catalogChanged.channel, {
      peers: this.getCatalog(),
    });
  }

  // ── Local announce ────────────────────────────────────────────────────────
  private buildLocalAnnounce(): SharedMediaMeta[] {
    return store.listShared().map((i) => ({
      fileName: i.fileName,
      kind: i.kind,
      mimeType: i.mimeType,
      sizeBytes: i.sizeBytes,
      prompt: i.prompt,
      thumbnail: i.thumbnail,
    }));
  }

  /** Re-broadcast our sharable set to all trusted peers (called on toggle). */
  announceToAll(): void {
    if (!this.bridge) return;
    this.bridge.broadcastToTrusted({
      type: "MEDIA_ANNOUNCE",
      items: this.buildLocalAnnounce(),
    });
  }

  /** Called by swarm when a trusted peer finishes its handshake. */
  onPeerReady(peerKey: string): void {
    if (!this.bridge) return;
    // Send our list and ask for theirs.
    this.bridge.sendToPeer(peerKey, {
      type: "MEDIA_ANNOUNCE",
      items: this.buildLocalAnnounce(),
    });
    this.bridge.sendToPeer(peerKey, { type: "MEDIA_LIST_REQUEST" });
  }

  /** Called by swarm when a peer disconnects — drop its catalog. */
  onPeerGone(peerKey: string): void {
    if (this.remoteCatalogs.delete(peerKey)) this.emitCatalogChanged();
  }

  // ── Public read API (for IPC) ──────────────────────────────────────────────
  getCatalog(): SharedPeerCatalog[] {
    return Array.from(this.remoteCatalogs.values());
  }

  /** Ask all trusted peers to re-send their catalog. */
  requestRefresh(): void {
    this.bridge?.broadcastToTrusted({ type: "MEDIA_LIST_REQUEST" });
  }

  // ── Download initiation (for IPC) ──────────────────────────────────────────
  requestDownload(
    peerKey: string,
    fileName: string,
  ): { ok: boolean; message: string } {
    if (!this.bridge) return { ok: false, message: "Network not ready" };
    const catalog = this.remoteCatalogs.get(peerKey);
    const meta = catalog?.items.find((i) => i.fileName === fileName);
    if (!meta) return { ok: false, message: "File no longer available" };

    const requestId = `dl_${Date.now()}_${this.reqCounter++}`;
    this.pending.set(requestId, { peerKey, meta, chunks: [], received: 0 });
    const sent = this.bridge.sendToPeer(peerKey, {
      type: "MEDIA_DOWNLOAD_REQUEST",
      requestId,
      fileName,
    });
    if (!sent) {
      this.pending.delete(requestId);
      return { ok: false, message: "Peer is offline" };
    }
    this.emitProgress(requestId, "downloading");
    return { ok: true, message: "Download started" };
  }

  private emitProgress(
    requestId: string,
    status: "downloading" | "done" | "error",
    error?: string,
  ): void {
    const p = this.pending.get(requestId);
    this.broadcastToRenderer(sharedMediaEvents.downloadProgress.channel, {
      fileName: p?.meta.fileName ?? "",
      peerKey: p?.peerKey ?? "",
      received: p?.received ?? 0,
      total: p?.meta.sizeBytes ?? 0,
      status,
      error: error ?? null,
    });
  }

  // ── Message dispatch (called by swarm._handleMessage) ──────────────────────
  async handleMessage(
    peerKey: string,
    channel: { send: (m: ChannelMessage) => boolean },
    msg: ChannelMessage,
  ): Promise<void> {
    switch (msg.type) {
      case "MEDIA_ANNOUNCE": {
        const displayName = this.bridge?.getDisplayName(peerKey) ?? "Peer";
        this.remoteCatalogs.set(peerKey, {
          peerKey,
          displayName,
          items: msg.items,
        });
        this.emitCatalogChanged();
        return;
      }

      case "MEDIA_LIST_REQUEST": {
        channel.send({
          type: "MEDIA_ANNOUNCE",
          items: this.buildLocalAnnounce(),
        });
        return;
      }

      case "MEDIA_DOWNLOAD_REQUEST": {
        await this.serveFile(channel, msg.requestId, msg.fileName);
        return;
      }

      case "MEDIA_DOWNLOAD_CHUNK": {
        this.receiveChunk(msg.requestId, msg.data, msg.eof);
        return;
      }

      case "MEDIA_DOWNLOAD_ERROR": {
        logger.warn(`Peer reported download error: ${msg.error}`);
        this.emitProgress(msg.requestId, "error", msg.error);
        this.pending.delete(msg.requestId);
        return;
      }

      default:
        return;
    }
  }

  // ── Serving (owner side) ────────────────────────────────────────────────────
  private async serveFile(
    channel: { send: (m: ChannelMessage) => boolean },
    requestId: string,
    fileName: string,
  ): Promise<void> {
    try {
      // Only serve files the user actually marked sharable.
      const item = store.list().find((i) => i.fileName === fileName);
      if (!item || !item.shared) {
        channel.send({
          type: "MEDIA_DOWNLOAD_ERROR",
          requestId,
          error: "File is not shared",
        });
        return;
      }
      const bytes = store.readFileBytes(fileName);
      for (let off = 0; off < bytes.length; off += CHUNK_SIZE) {
        const slice = bytes.subarray(off, off + CHUNK_SIZE);
        const eof = off + CHUNK_SIZE >= bytes.length;
        channel.send({
          type: "MEDIA_DOWNLOAD_CHUNK",
          requestId,
          data: slice.toString("base64"),
          eof,
        });
        // Yield so we don't block the event loop on large files.
        await new Promise((r) => setImmediate(r));
      }
    } catch (err) {
      channel.send({
        type: "MEDIA_DOWNLOAD_ERROR",
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Receiving (requester side) ──────────────────────────────────────────────
  private receiveChunk(requestId: string, dataB64: string, eof: boolean): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    const buf = Buffer.from(dataB64, "base64");
    p.chunks.push(buf);
    p.received += buf.length;
    this.emitProgress(requestId, "downloading");

    if (eof) {
      void this.finishDownload(requestId);
    }
  }

  private async finishDownload(requestId: string): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p) return;
    try {
      const full = Buffer.concat(p.chunks);
      const ext = extFromName(p.meta.fileName);
      await store.saveBuffer(full, {
        ext,
        promptOrStem: p.meta.prompt ?? "shared",
        prompt: p.meta.prompt,
      });
      this.emitProgress(requestId, "done");
      // Tell the Library to refresh its local list.
      this.broadcastToRenderer("generated-media:changed", {
        count: store.list().length,
      });
      logger.info(
        `Downloaded shared media ${p.meta.fileName} from ${p.peerKey.slice(0, 12)}…`,
      );
    } catch (err) {
      this.emitProgress(
        requestId,
        "error",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.pending.delete(requestId);
    }
  }
}

function extFromName(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : ".bin";
}

export const mediaShare = new MediaShare();
