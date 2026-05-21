/**
 * Hyperswarm P2P networking core.
 *
 * - Joins DHT topic = SHA256("orionbuilder-v1") for global peer discovery.
 * - Each Hyperswarm connection is Noise-encrypted automatically.
 * - On connect, both sides exchange HELLO + METADATA.
 * - Keep-alive pings every 10s measure latency and detect dead connections.
 * - Duplicate connections to the same peer are deduplicated.
 * - A UDP LAN broadcaster (see lan-discovery.ts) runs in parallel so devices
 *   on the same network find each other instantly without depending on DHT.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import log from "electron-log";
import {
  getOrCreateKeypair,
  getPrivateKeyBytes,
} from "@/main/identity/keypair";
import { handleInferenceRequest } from "@/main/compute/compute-node";
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
import { lanDiscovery, type LanPeer } from "./lan-discovery";
import {
  getCurrentBroadcastState,
  broadcastNow,
} from "@/main/compute/load-monitor";

const logger = log.scope("network:swarm");

interface ConnectedPeerEntry {
  channel: PeerChannel;
  peer: Peer;
  /** Timestamp ms of last successful read from the socket (data or pong). */
  lastSeenAt: number;
  /** Outstanding ping nonce → sentAt ms. */
  pings: Map<number, number>;
  /** Whether we've received METADATA from this peer yet. */
  metadataReceived: boolean;
  /** Wall-clock ms of the last LOAD_UPDATE we received from this peer. */
  lastLoadUpdateAt: number | null;
}

const connectedPeers = new Map<string, ConnectedPeerEntry>();

// Pending invite lookups (code → waiting for peer)
const pendingInviteTopics = new Set<string>(); // hex topics

// LAN topics we've already joined (publicKey hex of LAN peer)
const lanJoinedTopics = new Set<string>();

const KEEPALIVE_INTERVAL_MS = 10_000;
const KEEPALIVE_TIMEOUT_MS = 25_000;
const REFLUSH_INTERVAL_MS = 60_000;

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
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private reflushTimer: ReturnType<typeof setInterval> | null = null;
  private pingNonceCounter = 1;

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

      // flush() can time out on slow networks — that's fine, DHT still works
      await this.swarm
        .flush()
        .catch((err: unknown) =>
          logger.warn("Swarm flush timed out (non-fatal):", err),
        );
      this.isOnline = true;

      // Start LAN broadcast discovery in parallel with the DHT join.
      try {
        const identity = await getDeviceIdentity();
        await lanDiscovery.start({
          publicKey: identity.publicKey,
          displayName: identity.deviceName,
          deviceName: identity.deviceName,
          appVersion: app.getVersion(),
        });
        lanDiscovery.on("peer-seen", (lanPeer) => this._onLanPeer(lanPeer));
      } catch (err) {
        logger.warn("LAN discovery failed to start (non-fatal):", err);
      }

      // Periodic keep-alive pings + dead-connection cleanup
      this.keepaliveTimer = setInterval(
        () => this._keepalivePass(),
        KEEPALIVE_INTERVAL_MS,
      );
      // Re-flush the DHT periodically — peers that came online after our
      // initial flush sometimes only become routable on the next gossip cycle.
      this.reflushTimer = setInterval(
        () => this._reflushPass(),
        REFLUSH_INTERVAL_MS,
      );

      logger.info("Hyperswarm started, joined discovery topic");
    } catch (err) {
      logger.error("Failed to start swarm:", err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.reflushTimer) clearInterval(this.reflushTimer);
    this.keepaliveTimer = null;
    this.reflushTimer = null;
    await lanDiscovery.stop().catch(() => undefined);
    if (!this.swarm) return;
    try {
      await this.swarm.destroy();
    } catch {}
    this.swarm = null;
    this.isOnline = false;
    for (const { channel } of connectedPeers.values()) {
      channel.close();
    }
    connectedPeers.clear();
    lanJoinedTopics.clear();
    this.emit("peers-changed", []);
    logger.info("Hyperswarm stopped");
  }

  async joinInviteTopic(topic: Buffer): Promise<void> {
    if (!this.swarm) throw new Error("Swarm not started");
    const topicHex = topic.toString("hex");
    if (pendingInviteTopics.has(topicHex)) return;
    pendingInviteTopics.add(topicHex);
    this.swarm.join(topic, { server: true, client: true });
    await this.swarm
      .flush()
      .catch((err: unknown) =>
        logger.warn("Invite topic flush timed out (non-fatal):", err),
      );

    // Auto-leave after 60s
    setTimeout(() => {
      pendingInviteTopics.delete(topicHex);
      try {
        this.swarm?.leave(topic);
      } catch {}
    }, 60_000);
  }

  /**
   * When LAN discovery sees a peer, derive a per-peer rendezvous topic from
   * sorted (selfPublicKey, peerPublicKey) so both sides compute the same hash,
   * then join it. The DHT topic still runs in parallel; this just gives us a
   * faster path for devices that share a network.
   */
  private _onLanPeer(lanPeer: LanPeer): void {
    if (!this.swarm) return;
    if (lanJoinedTopics.has(lanPeer.publicKey)) return;
    void this._joinLanRendezvous(lanPeer);
  }

  private async _joinLanRendezvous(lanPeer: LanPeer): Promise<void> {
    try {
      const identity = await getDeviceIdentity();
      const [a, b] = [identity.publicKey, lanPeer.publicKey].sort();
      const topic = crypto
        .createHash("sha256")
        .update("orion-lan-pair-")
        .update(a)
        .update(b)
        .digest();
      lanJoinedTopics.add(lanPeer.publicKey);
      this.swarm.join(topic, { server: true, client: true });
      await this.swarm.flush().catch(() => undefined);
      logger.info(
        `Joined LAN rendezvous topic for ${lanPeer.displayName} (${lanPeer.publicKey.slice(0, 16)}…)`,
      );
    } catch (err) {
      logger.warn("LAN rendezvous join failed:", err);
    }
  }

  private async _handleConnection(socket: any, _info: any) {
    const remoteKeyHex: string = Buffer.from(socket.remotePublicKey).toString(
      "hex",
    );

    // Dedup: if we already have a healthy channel to this peer, drop the new
    // socket. Hyperswarm can race client/server connections under the hood.
    const existing = connectedPeers.get(remoteKeyHex);
    if (existing && !existing.channel.isClosed()) {
      logger.info(
        `Duplicate connection from ${remoteKeyHex.slice(0, 16)}… — closing new socket`,
      );
      try {
        socket.destroy?.();
      } catch {}
      return;
    }

    const channel = new PeerChannel(socket);
    logger.info(`New connection from ${remoteKeyHex.slice(0, 16)}…`);

    // Initialize a placeholder entry — gets enriched on METADATA.
    connectedPeers.set(remoteKeyHex, {
      channel,
      peer: this._placeholderPeer(remoteKeyHex),
      lastSeenAt: Date.now(),
      pings: new Map(),
      metadataReceived: false,
      lastLoadUpdateAt: null,
    });

    // Send our HELLO then full metadata
    try {
      const identity = await getDeviceIdentity();
      channel.send({
        type: "HELLO",
        publicKey: identity.publicKey,
        displayName: identity.deviceName,
      });
      channel.send({
        type: "METADATA",
        payload: await this._buildMetadata(),
      });
      // Don't wait the full 2 s for the next load-monitor tick — push our
      // current load/models immediately and request the peer's too.
      void broadcastNow().catch(() => undefined);
      channel.send({ type: "REQUEST_LOAD" });
    } catch (err) {
      logger.warn(
        `Failed to send handshake to ${remoteKeyHex.slice(0, 16)}…:`,
        err,
      );
      channel.close();
      return;
    }

    channel.on("error", (err: Error) => {
      logger.warn(
        `Socket error from ${remoteKeyHex.slice(0, 16)}… : ${err.message}`,
      );
    });

    channel.on("message", (msg: ChannelMessage) => {
      const entry = connectedPeers.get(remoteKeyHex);
      if (entry) entry.lastSeenAt = Date.now();
      this._handleMessage(remoteKeyHex, channel, msg);
    });

    channel.on("close", () => {
      const entry = connectedPeers.get(remoteKeyHex);
      if (entry?.channel !== channel) return; // already replaced
      const displayName = entry.peer.displayName;
      connectedPeers.delete(remoteKeyHex);
      this.emit("peers-changed", this._getPeerList());
      logger.info(
        `Peer ${displayName} (${remoteKeyHex.slice(0, 16)}…) disconnected`,
      );
      this.emit(
        "notification",
        "peer_offline",
        `${displayName} disconnected`,
        "",
      );
    });
  }

  private async _handleMessage(
    remoteKeyHex: string,
    channel: PeerChannel,
    msg: ChannelMessage,
  ) {
    if (msg.type === "PING") {
      channel.send({ type: "PONG", nonce: msg.nonce });
      return;
    }

    if (msg.type === "PONG") {
      const entry = connectedPeers.get(remoteKeyHex);
      if (!entry) return;
      const sentAt = entry.pings.get(msg.nonce);
      if (sentAt !== undefined) {
        const latency = Date.now() - sentAt;
        entry.pings.delete(msg.nonce);
        entry.peer = {
          ...entry.peer,
          latencyMs: latency,
          status: "online",
        };
        this.emit("peers-changed", this._getPeerList());
      }
      return;
    }

    if (msg.type === "METADATA") {
      const p = msg.payload;
      const trusted = isTrustedPeer(p.publicKey);
      const lanAddr = lanDiscovery.getAddress(p.publicKey);
      const existing = connectedPeers.get(remoteKeyHex);
      // If the peer's METADATA carried real model info (new builds), keep that
      // as the initial load timestamp so we don't show stale "never updated".
      const initialHasLoadInfo =
        p.loadedModels.length > 0 ||
        p.computeAvailable === true ||
        p.gpuUtilization > 0;
      const peer: Peer = {
        publicKey: p.publicKey,
        fingerprint: p.publicKey.slice(0, 16).toUpperCase(),
        displayName: p.displayName,
        deviceName: p.deviceName,
        deviceType: p.deviceType,
        hardware: p.hardware,
        status: "online",
        isTrusted: trusted,
        isLan: lanAddr !== null,
        latencyMs: existing?.peer.latencyMs ?? null,
        lastSeenAt: Date.now(),
        lastLoadUpdateAt:
          existing?.lastLoadUpdateAt ??
          (initialHasLoadInfo ? Date.now() : null),
        loadedModels: p.loadedModels,
        gpuUtilization: p.gpuUtilization,
        computeAvailable: p.computeAvailable,
        appVersion: p.appVersion,
      };

      const wasNew = !existing || !existing.metadataReceived;
      connectedPeers.set(remoteKeyHex, {
        channel,
        peer,
        lastSeenAt: Date.now(),
        pings: existing?.pings ?? new Map(),
        metadataReceived: true,
        lastLoadUpdateAt: peer.lastLoadUpdateAt,
      });
      if (trusted) updatePeerLastSeen(p.publicKey);

      this.emit("peers-changed", this._getPeerList());
      if (wasNew) {
        this.emit(
          "notification",
          "peer_online",
          `${peer.displayName} came online`,
          `${peer.deviceName} · ${peer.hardware?.gpu ?? ""}`,
          { publicKey: peer.publicKey },
        );
      }
      return;
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
      return;
    }

    if (msg.type === "LOAD_UPDATE") {
      const entry = connectedPeers.get(remoteKeyHex);
      if (entry) {
        const now = Date.now();
        entry.lastLoadUpdateAt = now;
        entry.peer = {
          ...entry.peer,
          gpuUtilization: msg.gpuUtilization,
          loadedModels: msg.loadedModels,
          computeAvailable: msg.computeAvailable,
          lastLoadUpdateAt: now,
        };
        this.emit("peers-changed", this._getPeerList());
      }
      return;
    }

    if (msg.type === "REQUEST_LOAD") {
      // Peer wants a fresh broadcast — push immediately.
      void broadcastNow().catch(() => undefined);
      return;
    }

    if (msg.type === "INFERENCE_REQUEST") {
      // Trust gate: only serve inference for trusted peers. Anyone else gets
      // an explicit denial back so they don't sit waiting for chunks.
      if (!isTrustedPeer(remoteKeyHex)) {
        logger.warn(
          `Rejecting INFERENCE_REQUEST from untrusted ${remoteKeyHex.slice(0, 16)}…`,
        );
        channel.send({
          type: "INFERENCE_ERROR",
          requestId: msg.requestId,
          error: "Peer is not in your trusted list",
        });
        return;
      }
      void handleInferenceRequest(channel, msg.requestId, msg.body);
      return;
    }

    if (msg.type === "INFERENCE_CANCEL") {
      const { cancelRequest } = await import("@/main/compute/compute-node");
      cancelRequest(msg.requestId);
      return;
    }

    if (msg.type === "FRIEND_ACCEPT") {
      addTrustedPeer({
        publicKey: msg.fromPublicKey,
        displayName: msg.fromPublicKey.slice(0, 8),
      });
      const entry = connectedPeers.get(msg.fromPublicKey);
      if (entry) {
        entry.peer = { ...entry.peer, isTrusted: true };
        this.emit("peers-changed", this._getPeerList());
      }
      return;
    }
  }

  sendFriendRequest(targetPublicKey: string): void {
    const entry = connectedPeers.get(targetPublicKey);
    if (!entry) throw new Error("Peer not connected");
    getDeviceIdentity()
      .then((identity) => {
        entry.channel.send({
          type: "FRIEND_REQUEST",
          fromPublicKey: identity.publicKey,
          fromDisplayName: identity.deviceName,
          fromDeviceName: identity.deviceName,
        });
      })
      .catch((err) => logger.warn("sendFriendRequest failed:", err));
  }

  notifyFriendAccepted(targetPublicKey: string): void {
    const entry = connectedPeers.get(targetPublicKey);
    if (!entry) return;
    getDeviceIdentity()
      .then((identity) => {
        try {
          entry.channel.send({
            type: "FRIEND_ACCEPT",
            fromPublicKey: identity.publicKey,
          });
        } catch (err) {
          logger.warn("notifyFriendAccepted send failed:", err);
        }
        addTrustedPeer({
          publicKey: targetPublicKey,
          displayName: entry.peer.displayName,
        });
        entry.peer = { ...entry.peer, isTrusted: true };
        this.emit("peers-changed", this._getPeerList());
      })
      .catch((err) => logger.warn("notifyFriendAccepted failed:", err));
  }

  // ── Distributed Compute ──────────────────────────────────────────────────

  broadcastLoad(load: {
    gpuUtilization: number;
    loadedModels: string[];
    computeAvailable: boolean;
    queueDepth: number;
  }): void {
    for (const { channel } of connectedPeers.values()) {
      try {
        channel.send({ type: "LOAD_UPDATE", ...load });
      } catch {}
    }
  }

  /**
   * Send an inference request to a specific peer. Returns a cleanup fn.
   * onChunk receives raw SSE text chunks; onDone called on completion/error.
   */
  sendInferenceRequest(
    peerId: string,
    requestId: string,
    bodyJson: string,
    onChunk: (data: string) => void,
    onDone: (err?: string) => void,
  ): (() => void) | null {
    const entry = connectedPeers.get(peerId);
    if (!entry || entry.channel.isClosed()) {
      onDone(
        entry
          ? "Peer connection closed"
          : "Peer not connected — try selecting a different device",
      );
      return null;
    }

    let finished = false;
    const finish = (err?: string) => {
      if (finished) return;
      finished = true;
      entry.channel.off("message", handler);
      entry.channel.off("close", onClose);
      onDone(err);
    };

    const onClose = () => finish("Peer disconnected during inference");

    const handler = (msg: import("./peer-channel").ChannelMessage) => {
      if (msg.type === "INFERENCE_CHUNK" && msg.requestId === requestId) {
        onChunk(msg.data);
      } else if (msg.type === "INFERENCE_DONE" && msg.requestId === requestId) {
        finish();
      } else if (
        msg.type === "INFERENCE_ERROR" &&
        msg.requestId === requestId
      ) {
        finish(msg.error);
      }
    };

    entry.channel.on("message", handler);
    entry.channel.on("close", onClose);

    const sent = entry.channel.send({
      type: "INFERENCE_REQUEST",
      requestId,
      body: bodyJson,
    });
    if (!sent) {
      finish("Failed to send request — peer channel closed");
      return null;
    }

    return () => finish();
  }

  cancelInferenceRequest(peerId: string, requestId: string): void {
    const entry = connectedPeers.get(peerId);
    entry?.channel.send({ type: "INFERENCE_CANCEL", requestId });
  }

  getStatus() {
    return {
      isOnline: this.isOnline,
      peers: this._getPeerList(),
    };
  }

  /** Public accessor — true if we have an open channel to this peer. */
  isPeerConnected(publicKey: string): boolean {
    const entry = connectedPeers.get(publicKey);
    return !!entry && !entry.channel.isClosed();
  }

  private _getPeerList(): Peer[] {
    return Array.from(connectedPeers.values()).map((e) => e.peer);
  }

  private _placeholderPeer(remoteKeyHex: string): Peer {
    const trusted = isTrustedPeer(remoteKeyHex);
    return {
      publicKey: remoteKeyHex,
      fingerprint: remoteKeyHex.slice(0, 16).toUpperCase(),
      displayName: trusted
        ? remoteKeyHex.slice(0, 8)
        : `Unknown ${remoteKeyHex.slice(0, 6)}`,
      deviceName: "—",
      deviceType: "desktop",
      hardware: null,
      status: "connecting",
      isTrusted: trusted,
      isLan: lanDiscovery.getAddress(remoteKeyHex) !== null,
      latencyMs: null,
      lastSeenAt: Date.now(),
      lastLoadUpdateAt: null,
      loadedModels: [],
      gpuUtilization: 0,
      computeAvailable: false,
      appVersion: "",
    };
  }

  /** Ask a specific connected peer to push a fresh LOAD_UPDATE. Returns true
   *  if the request was sent (peer connected), false otherwise. */
  requestPeerRefresh(publicKey: string): boolean {
    const entry = connectedPeers.get(publicKey);
    if (!entry || entry.channel.isClosed()) return false;
    return entry.channel.send({ type: "REQUEST_LOAD" });
  }

  /** Send a PING to every connected peer; close anything that hasn't been heard
   *  from in KEEPALIVE_TIMEOUT_MS. */
  private _keepalivePass(): void {
    const now = Date.now();
    for (const [key, entry] of connectedPeers) {
      if (entry.channel.isClosed()) continue;
      if (now - entry.lastSeenAt > KEEPALIVE_TIMEOUT_MS) {
        logger.warn(
          `Peer ${key.slice(0, 16)}… is dead (no traffic in ${Math.round((now - entry.lastSeenAt) / 1000)}s) — closing`,
        );
        entry.channel.close();
        continue;
      }
      const nonce = this.pingNonceCounter++;
      entry.pings.set(nonce, now);
      // Drop pings older than 30s so the map doesn't grow unbounded.
      for (const [n, t] of entry.pings) {
        if (now - t > 30_000) entry.pings.delete(n);
      }
      entry.channel.send({ type: "PING", nonce });
    }
  }

  private _reflushPass(): void {
    if (!this.swarm) return;
    void this.swarm
      .flush()
      .catch((err: unknown) =>
        logger.debug("Periodic swarm flush failed (non-fatal):", err),
      );
  }

  private async _buildMetadata(): Promise<PeerMetadataPayload> {
    const identity = await getDeviceIdentity();
    // Seed METADATA with our real current load state so the peer doesn't see
    // a stale "no models / not sharing" snapshot for the 2s window before the
    // next LOAD_UPDATE tick.
    const snapshot = getCurrentBroadcastState();
    return {
      publicKey: identity.publicKey,
      displayName: identity.deviceName,
      deviceName: identity.deviceName,
      deviceType: identity.deviceType,
      hardware: identity.hardware,
      loadedModels: snapshot.loadedModels,
      gpuUtilization: snapshot.gpuUtilization,
      computeAvailable: snapshot.computeAvailable,
      appVersion: app.getVersion(),
    };
  }
}

export const networkSwarm = new NetworkSwarm();
