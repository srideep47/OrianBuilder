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
  | { type: "PING" }
  | { type: "PONG" };

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

  constructor(private socket: NodeJS.ReadWriteStream) {
    super();
    socket.on("data", (chunk: Buffer) => this._onData(chunk));
    socket.on("error", (err) => this.emit("error", err));
    socket.on("close", () => this.emit("close"));
    socket.on("end", () => this.emit("close"));
  }

  send(msg: ChannelMessage): void {
    const json = Buffer.from(JSON.stringify(msg), "utf-8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(json.length, 0);
    this.socket.write(Buffer.concat([header, json]));
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
