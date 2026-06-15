/**
 * Raw-TCP LAN fallback transport.
 *
 * Hyperswarm needs native (sodium/udx) addons. The Android client runs inside
 * nodejs-mobile where those addons crash the process, so it falls back to a
 * pure-JS raw-TCP transport: it advertises a `tcpPort` in its LAN beacon and
 * direct-connects over TCP with an Ed25519 challenge-response handshake.
 *
 * This module is the DESKTOP half of that transport — byte-for-byte compatible
 * with the Android bridge (`p2p-bridge.js`): same auth context string, same
 * RFC 8410 DER key wrapping, same `LAN_AUTH_HELLO`/`LAN_AUTH_PROOF` flow, and
 * the same length-prefixed JSON framing ({@link PeerChannel}). Once a channel
 * is authenticated it is handed to the swarm and behaves exactly like a
 * Hyperswarm connection (HELLO/METADATA/PING/INFERENCE/MEDIA all unchanged).
 *
 * Connection direction is deterministic — the smaller public key dials — so a
 * desktop and a phone never both dial each other.
 */

import net from "node:net";
import crypto from "node:crypto";
import log from "electron-log";
import { PeerChannel } from "./peer-channel";
import type { LanPeer } from "./lan-discovery";

const logger = log.scope("network:lan-tcp");

const LAN_AUTH_CONTEXT = "orion-lan-auth-v1";
const LAN_AUTH_TIMEOUT_MS = 10_000;

// RFC 8410 DER prefixes for wrapping raw Ed25519 keys into PKCS#8 / SPKI for
// node:crypto. Identical to the Android bridge.
const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface LanTcpOptions {
  /** Our raw Ed25519 public key, hex (32 bytes). */
  publicKeyHex: string;
  /** Our raw Ed25519 private seed (32 bytes). */
  privateKeyBytes: Uint8Array;
  /** Called with an authenticated channel + the verified remote public key. */
  onChannel: (channel: PeerChannel, remoteKeyHex: string) => void;
  /** Returns true if we already have a live channel to this peer (any transport). */
  isConnected: (publicKeyHex: string) => boolean;
}

export class LanTcpTransport {
  private server: net.Server | null = null;
  private port = 0;
  private privObj: crypto.KeyObject;
  private readonly selfPubHex: string;
  private readonly onChannel: LanTcpOptions["onChannel"];
  private readonly isConnected: LanTcpOptions["isConnected"];
  private dialing = new Set<string>();
  private sockets = new Set<net.Socket>();

  constructor(opts: LanTcpOptions) {
    this.selfPubHex = opts.publicKeyHex;
    this.onChannel = opts.onChannel;
    this.isConnected = opts.isConnected;
    const seed = Buffer.from(opts.privateKeyBytes);
    if (seed.length !== 32) throw new Error("private seed must be 32 bytes");
    this.privObj = crypto.createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
  }

  getPort(): number {
    return this.port;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => {
        sock.setNoDelay(true);
        this._track(sock);
        void this._authenticate(new PeerChannel(sock));
      });
      server.on("error", (err) => {
        logger.warn("TCP listener error:", err.message);
        reject(err);
      });
      server.listen(0, "0.0.0.0", () => {
        const addr = server.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        this.server = server;
        logger.info(`LAN-TCP transport listening on :${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.dialing.clear();
    const server = this.server;
    this.server = null;
    this.port = 0;
    // Destroy live sockets first so server.close() can resolve immediately
    // (it otherwise waits indefinitely for open connections to drain).
    for (const s of this.sockets) {
      try {
        s.destroy();
      } catch {}
    }
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private _track(sock: net.Socket): void {
    this.sockets.add(sock);
    sock.once("close", () => this.sockets.delete(sock));
  }

  /** A LAN beacon was heard. Dial it over TCP when we're the designated dialer. */
  onPeerSeen(peer: LanPeer): void {
    if (!this.server) return;
    if (!peer.tcpPort) return; // peer has no TCP fallback (DHT-only desktop)
    // Deterministic direction: the smaller public key dials. Mirrors the bridge.
    if (this.selfPubHex >= peer.publicKey) return;
    if (this.isConnected(peer.publicKey)) return;
    if (this.dialing.has(peer.publicKey)) return;

    this.dialing.add(peer.publicKey);
    const sock = net.connect({ host: peer.address, port: peer.tcpPort }, () =>
      sock.setNoDelay(true),
    );
    this._track(sock);
    sock.on("error", (err) => {
      logger.warn(
        `TCP dial to ${peer.displayName} (${peer.address}:${peer.tcpPort}) failed: ${err.message}`,
      );
    });
    const channel = new PeerChannel(sock);
    const done = () => this.dialing.delete(peer.publicKey);
    channel.on("close", done);
    void this._authenticate(channel, peer.publicKey).then(done, done);
  }

  /**
   * Mutual Ed25519 challenge-response. Both sides send LAN_AUTH_HELLO
   * {publicKey, nonce}, reply with LAN_AUTH_PROOF {signature over
   * context‖remoteNonce‖selfPub}, and only adopt the channel after verifying
   * the peer's proof. `expectedHex` is set when we initiated the dial.
   */
  private _authenticate(
    channel: PeerChannel,
    expectedHex: string | null = null,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const nonce = crypto.randomBytes(16).toString("hex");
      let remoteHello: { publicKey: string; nonce: string } | null = null;
      let verified = false;
      let settled = false;

      const timeout = setTimeout(() => finish(false), LAN_AUTH_TIMEOUT_MS);

      const finish = (ok: boolean, remoteHex?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        channel.off("message", onMessage);
        if (ok && remoteHex) {
          this.onChannel(channel, remoteHex);
          resolve(true);
        } else {
          channel.close();
          resolve(false);
        }
      };

      const onMessage = (msg: any) => {
        if (msg?.type === "LAN_AUTH_HELLO") {
          if (
            typeof msg.publicKey !== "string" ||
            typeof msg.nonce !== "string"
          )
            return finish(false);
          if (expectedHex && msg.publicKey !== expectedHex)
            return finish(false);
          if (msg.publicKey === this.selfPubHex) return finish(false);
          remoteHello = { publicKey: msg.publicKey, nonce: msg.nonce };
          (channel as any).send({
            type: "LAN_AUTH_PROOF",
            signature: this._signAuth(msg.nonce),
          });
          return;
        }
        if (msg?.type === "LAN_AUTH_PROOF") {
          if (!remoteHello) return finish(false);
          verified = this._verifyAuth(
            nonce,
            remoteHello.publicKey,
            msg.signature,
          );
          return finish(verified, remoteHello.publicKey);
        }
        // Any non-auth message before the handshake completes is a violation.
        if (!verified) return finish(false);
      };

      channel.on("message", onMessage);
      channel.once("close", () => finish(false));
      // PeerChannel.send only accepts ChannelMessage types; the auth frames are
      // transport-private, so go through the cast.
      (channel as any).send({
        type: "LAN_AUTH_HELLO",
        publicKey: this.selfPubHex,
        nonce,
      });
    });
  }

  private _signAuth(remoteNonceHex: string): string {
    const data = Buffer.from(
      LAN_AUTH_CONTEXT + remoteNonceHex + this.selfPubHex,
      "utf-8",
    );
    return crypto.sign(null, data, this.privObj).toString("hex");
  }

  private _verifyAuth(
    selfNonceHex: string,
    remotePubHex: string,
    signatureHex: string,
  ): boolean {
    try {
      const data = Buffer.from(
        LAN_AUTH_CONTEXT + selfNonceHex + remotePubHex,
        "utf-8",
      );
      const pub = crypto.createPublicKey({
        key: Buffer.concat([
          ED25519_SPKI_PREFIX,
          Buffer.from(remotePubHex, "hex"),
        ]),
        format: "der",
        type: "spki",
      });
      return crypto.verify(null, data, pub, Buffer.from(signatureHex, "hex"));
    } catch {
      return false;
    }
  }
}
