/**
 * Hyperswarm P2P networking core.
 *
 * - Joins DHT topic = SHA256("orionbuilder-v1") for peer discovery
 * - Each connection uses Noise protocol (encrypted automatically by Hyperswarm)
 * - Exchanges peer metadata on connect
 * - Tracks trusted vs unknown peers
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import log from "electron-log";
import {
  getOrCreateKeypair,
  getPrivateKeyBytes,
} from "@/main/identity/keypair";
import { getDeviceIdentity } from "@/main/identity/device";
import {
  isTrustedPeer,
  addTrustedPeer,
  updatePeerLastSeen,
  createFriendRequest,
} from "./friends";
import {
  PeerChannel,
  type PeerMetadataPayload,
  type ChannelMessage,
} from "./peer-channel";
import type { Peer } from "@/ipc/types/network";
import { app } from "electron";

const logger = log.scope("network:swarm");

// Live connected peers indexed by hex public key
const connectedPeers = new Map<string, { channel: PeerChannel; peer: Peer }>();

// Pending invite lookups (code → waiting for peer)
const pendingInviteTopics = new Set<string>(); // hex topics

type SwarmEvents = {
  "peers-changed": [peers: Peer[]];
  notification: [
    type: string,
    title: string,
    body: string,
    meta?: Record<string, unknown>,
  ];
  "friend-request": [
    req: {
      fromPublicKey: string;
      fromDisplayName: string;
      fromDeviceName: string;
    },
  ];
};

class NetworkSwarm extends EventEmitter<SwarmEvents> {
  private swarm: any = null;
  private isOnline = false;
  private mainTopic: Buffer | null = null;

  async start(): Promise<void> {
    if (this.isOnline) return;
    try {
      const { default: Hyperswarm } = await import("hyperswarm");
      const keypair = await getOrCreateKeypair();
      const privBytes = await getPrivateKeyBytes();
      const { getPublicKeyAsync } = await import("@noble/ed25519");
      const pubBytes = await getPublicKeyAsync(privBytes);

      // Hyperswarm needs a 64-byte sodium-format secret key = seed(32) + pubkey(32)
      const secretKey = Buffer.concat([
        Buffer.from(privBytes),
        Buffer.from(pubBytes),
      ]);
      const publicKey = Buffer.from(keypair.publicKey, "hex");

      this.swarm = new Hyperswarm({ keyPair: { publicKey, secretKey } });

      this.swarm.on("connection", (socket: any, info: any) => {
        this._handleConnection(socket, info);
      });

      // Join the main discovery topic
      this.mainTopic = crypto
        .createHash("sha256")
        .update("orionbuilder-v1")
        .digest();
      this.swarm.join(this.mainTopic, { server: true, client: true });

      await this.swarm.flush();
      this.isOnline = true;
      logger.info("Hyperswarm started, joined discovery topic");
    } catch (err) {
      logger.error("Failed to start swarm:", err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.swarm) return;
    try {
      await this.swarm.destroy();
    } catch {}
    this.swarm = null;
    this.isOnline = false;
    connectedPeers.clear();
    this.emit("peers-changed", []);
    logger.info("Hyperswarm stopped");
  }

  async joinInviteTopic(topic: Buffer): Promise<void> {
    if (!this.swarm) throw new Error("Swarm not started");
    const topicHex = topic.toString("hex");
    if (pendingInviteTopics.has(topicHex)) return;
    pendingInviteTopics.add(topicHex);
    this.swarm.join(topic, { server: true, client: true });
    await this.swarm.flush();

    // Auto-leave after 60s
    setTimeout(() => {
      pendingInviteTopics.delete(topicHex);
      try {
        this.swarm?.leave(topic);
      } catch {}
    }, 60_000);
  }

  private async _handleConnection(socket: any, _info: any) {
    const remoteKeyHex: string = Buffer.from(socket.remotePublicKey).toString(
      "hex",
    );
    const channel = new PeerChannel(socket);

    logger.info(`New connection from ${remoteKeyHex.slice(0, 16)}…`);

    // Send our HELLO
    const identity = await getDeviceIdentity();
    channel.send({
      type: "HELLO",
      publicKey: identity.publicKey,
      displayName: identity.deviceName,
    });

    // Then send full metadata
    channel.send({
      type: "METADATA",
      payload: await this._buildMetadata(),
    });

    channel.on("message", (msg: ChannelMessage) => {
      this._handleMessage(remoteKeyHex, channel, msg);
    });

    channel.on("close", () => {
      const entry = connectedPeers.get(remoteKeyHex);
      if (entry) {
        connectedPeers.set(remoteKeyHex, {
          ...entry,
          peer: { ...entry.peer, status: "offline" },
        });
      }
      this.emit("peers-changed", this._getPeerList());
      this.emit(
        "notification",
        "peer_offline",
        `${connectedPeers.get(remoteKeyHex)?.peer.displayName ?? "Peer"} disconnected`,
        "",
        {},
      );
    });
  }

  private async _handleMessage(
    remoteKeyHex: string,
    channel: PeerChannel,
    msg: ChannelMessage,
  ) {
    if (msg.type === "PING") {
      channel.send({ type: "PONG" });
      return;
    }

    if (msg.type === "METADATA") {
      const p = msg.payload;
      const trusted = isTrustedPeer(p.publicKey);
      const peer: Peer = {
        publicKey: p.publicKey,
        fingerprint: p.publicKey.slice(0, 16).toUpperCase(),
        displayName: p.displayName,
        deviceName: p.deviceName,
        deviceType: p.deviceType,
        hardware: p.hardware,
        status: "online",
        isTrusted: trusted,
        isLan: false,
        latencyMs: null,
        lastSeenAt: Date.now(),
        loadedModels: p.loadedModels,
        gpuUtilization: p.gpuUtilization,
        computeAvailable: p.computeAvailable,
        appVersion: p.appVersion,
      };

      connectedPeers.set(p.publicKey, { channel, peer });
      if (trusted) updatePeerLastSeen(p.publicKey);

      this.emit("peers-changed", this._getPeerList());
      this.emit(
        "notification",
        "peer_online",
        `${peer.displayName} came online`,
        `${peer.deviceName} · ${peer.hardware?.gpu ?? ""}`,
        { publicKey: peer.publicKey },
      );
    }

    if (msg.type === "FRIEND_REQUEST") {
      const reqId = createFriendRequest({
        fromPublicKey: msg.fromPublicKey,
        fromDisplayName: msg.fromDisplayName,
        fromDeviceName: msg.fromDeviceName,
      });
      this.emit("friend-request", {
        fromPublicKey: msg.fromPublicKey,
        fromDisplayName: msg.fromDisplayName,
        fromDeviceName: msg.fromDeviceName,
      });
      this.emit(
        "notification",
        "friend_request",
        `Friend request from ${msg.fromDisplayName}`,
        "Tap to accept or decline",
        { requestId: reqId },
      );
    }

    if (msg.type === "FRIEND_ACCEPT") {
      addTrustedPeer({
        publicKey: msg.fromPublicKey,
        displayName: msg.fromPublicKey.slice(0, 8),
      });
      const entry = connectedPeers.get(msg.fromPublicKey);
      if (entry) {
        connectedPeers.set(msg.fromPublicKey, {
          ...entry,
          peer: { ...entry.peer, isTrusted: true },
        });
        this.emit("peers-changed", this._getPeerList());
      }
    }
  }

  sendFriendRequest(targetPublicKey: string): void {
    const entry = connectedPeers.get(targetPublicKey);
    if (!entry) throw new Error("Peer not connected");
    getDeviceIdentity().then((identity) => {
      entry.channel.send({
        type: "FRIEND_REQUEST",
        fromPublicKey: identity.publicKey,
        fromDisplayName: identity.deviceName,
        fromDeviceName: identity.deviceName,
      });
    });
  }

  notifyFriendAccepted(targetPublicKey: string): void {
    const entry = connectedPeers.get(targetPublicKey);
    if (!entry) return;
    getDeviceIdentity().then((identity) => {
      entry.channel.send({
        type: "FRIEND_ACCEPT",
        fromPublicKey: identity.publicKey,
      });
      addTrustedPeer({
        publicKey: targetPublicKey,
        displayName: entry.peer.displayName,
      });
      connectedPeers.set(targetPublicKey, {
        ...entry,
        peer: { ...entry.peer, isTrusted: true },
      });
      this.emit("peers-changed", this._getPeerList());
    });
  }

  getStatus() {
    return {
      isOnline: this.isOnline,
      peers: this._getPeerList(),
    };
  }

  private _getPeerList(): Peer[] {
    return Array.from(connectedPeers.values()).map((e) => e.peer);
  }

  private async _buildMetadata(): Promise<PeerMetadataPayload> {
    const identity = await getDeviceIdentity();
    return {
      publicKey: identity.publicKey,
      displayName: identity.deviceName,
      deviceName: identity.deviceName,
      deviceType: identity.deviceType,
      hardware: identity.hardware,
      loadedModels: [],
      gpuUtilization: 0,
      computeAvailable: false,
      appVersion: app.getVersion(),
    };
  }
}

export const networkSwarm = new NetworkSwarm();
