/**
 * Framed JSON message protocol over a Noise socket.
 * Format: [4-byte uint32 length BE][JSON payload bytes]
 */

import { EventEmitter } from "node:events";

export type ChannelMessage =
  | { type: "HELLO"; publicKey: string; displayName: string }
  | { type: "METADATA"; payload: PeerMetadataPayload }
  | {
      type: "FRIEND_REQUEST";
      fromPublicKey: string;
      fromDisplayName: string;
      fromDeviceName: string;
      inviteToken?: string;
    }
  | { type: "FRIEND_ACCEPT"; fromPublicKey: string }
  | { type: "PING"; nonce: number }
  | { type: "PONG"; nonce: number }
  // ── Distributed Compute (Phase 4) ──────────────────────────────────────────
  | { type: "INFERENCE_REQUEST"; requestId: string; body: string }
  | { type: "INFERENCE_CHUNK"; requestId: string; data: string }
  | { type: "INFERENCE_DONE"; requestId: string }
  | { type: "INFERENCE_ERROR"; requestId: string; error: string }
  | { type: "INFERENCE_CANCEL"; requestId: string }
  // ── Distributed media generation (Orion P2P job dispatch) ─────────────────
  /** Ask a trusted peer to generate one media asset on its hardware. */
  | {
      type: "MEDIA_GEN_REQUEST";
      requestId: string;
      modelType: "image" | "audio" | "video" | "music";
      prompt: string;
      /** Explicit model id (the requester's selection), when set. */
      modelId?: string;
      /** Generation settings forwarded to the dispatcher. */
      options?: Record<string, unknown>;
      /** File extension the requester expects, e.g. "png". */
      ext: string;
    }
  /** One base64 chunk of the generated file; eof marks the last chunk. */
  | { type: "MEDIA_GEN_CHUNK"; requestId: string; data: string; eof: boolean }
  | { type: "MEDIA_GEN_ERROR"; requestId: string; error: string }
  /** Ask the remote side to send a fresh LOAD_UPDATE right now. */
  | { type: "REQUEST_LOAD" }
  | {
      type: "LOAD_UPDATE";
      gpuUtilization: number;
      loadedModels: string[];
      computeAvailable: boolean;
      queueDepth: number;
    }
  // ── Media Sharing ───────────────────────────────────────────────────────
  /** Sender advertises its full set of sharable media. */
  | { type: "MEDIA_ANNOUNCE"; items: SharedMediaMeta[] }
  /** Ask a peer to (re)send its MEDIA_ANNOUNCE. */
  | { type: "MEDIA_LIST_REQUEST" }
  /** Request the bytes of one shared file (by the owner's fileName). */
  | { type: "MEDIA_DOWNLOAD_REQUEST"; requestId: string; fileName: string }
  /** One base64-encoded chunk of a requested file. */
  | {
      type: "MEDIA_DOWNLOAD_CHUNK";
      requestId: string;
      data: string;
      eof: boolean;
    }
  | { type: "MEDIA_DOWNLOAD_ERROR"; requestId: string; error: string };

/** Metadata describing a shared media item (sent in MEDIA_ANNOUNCE). */
export interface SharedMediaMeta {
  /** The owner's fileName — unique within that peer. */
  fileName: string;
  kind: "image" | "video" | "audio" | "model";
  mimeType: string;
  sizeBytes: number;
  prompt: string | null;
  /** Small base64 data-URL thumbnail (images/videos), optional. */
  thumbnail: string | null;
}

export interface PeerMetadataPayload {
  publicKey: string;
  displayName: string;
  deviceName: string;
  deviceType: "desktop" | "laptop" | "server";
  hardware: { cpu: string; ramGB: number; gpu: string; vramGB: number } | null;
  loadedModels: string[];
  gpuUtilization: number;
  computeAvailable: boolean;
  appVersion: string;
}

export class PeerChannel extends EventEmitter {
  private buf = Buffer.alloc(0);
  private closed = false;

  constructor(private socket: NodeJS.ReadWriteStream) {
    super();
    socket.on("data", (chunk: Buffer) => this._onData(chunk));
    socket.on("error", (err) => this.emit("error", err));
    // Both "end" and "close" can fire — guard so consumers only see one "close".
    socket.on("close", () => this._onClose());
    socket.on("end", () => this._onClose());
  }

  send(msg: ChannelMessage): boolean {
    if (this.closed) return false;
    try {
      const json = Buffer.from(JSON.stringify(msg), "utf-8");
      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(json.length, 0);
      this.socket.write(Buffer.concat([header, json]));
      return true;
    } catch {
      this._onClose();
      return false;
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    try {
      (this.socket as any).end?.();
      (this.socket as any).destroy?.();
    } catch {}
    this._onClose();
  }

  private _onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  private _onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const raw = this.buf.slice(4, 4 + len).toString("utf-8");
      this.buf = this.buf.slice(4 + len);
      try {
        const msg = JSON.parse(raw) as ChannelMessage;
        this.emit("message", msg);
      } catch {
        // malformed — ignore
      }
    }
  }
}
