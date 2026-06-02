/**
 * LAN-local peer discovery via UDP broadcast.
 *
 * Hyperswarm's DHT can take 10–60s to surface peers on the same LAN, and gets
 * blocked entirely by some routers / corporate NATs. This module gives us a
 * zero-dependency complement: every device broadcasts a small JSON beacon
 * (their Ed25519 public key + device name) on 255.255.255.255:38291 every 4s,
 * and listens for the same from others. Anyone heard within ~12s is reported
 * as a LAN peer.
 *
 * The beacon is intentionally tiny so it fits in one UDP packet on any link.
 * Trust still flows through the Hyperswarm Noise channel — UDP just gives us
 * the public key faster so we can direct-connect via swarm.joinPeer().
 */

import dgram from "node:dgram";
import os from "node:os";
import { EventEmitter } from "node:events";
import log from "electron-log";

const logger = log.scope("network:lan");

const PORT = 38291;
const BROADCAST_INTERVAL_MS = 15_000; // 15 s — peers are stable; saves constant UDP packets
const PEER_STALE_AFTER_MS = 45_000; // 3× broadcast interval
const MAGIC = "ORION-LAN-V1";

export interface LanBeacon {
  magic: typeof MAGIC;
  publicKey: string;
  displayName: string;
  deviceName: string;
  appVersion: string;
  timestamp: number;
}

export interface LanPeer {
  publicKey: string;
  displayName: string;
  deviceName: string;
  address: string;
  lastSeenAt: number;
}

type LanDiscoveryEvents = {
  "peer-seen": [peer: LanPeer];
  "peer-lost": [publicKey: string];
};

class LanDiscovery extends EventEmitter<LanDiscoveryEvents> {
  private socket: dgram.Socket | null = null;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private peers = new Map<string, LanPeer>();
  private self: Omit<LanBeacon, "magic" | "timestamp"> | null = null;
  private localAddresses = new Set<string>();
  private started = false;

  isStarted(): boolean {
    return this.started;
  }

  async start(self: Omit<LanBeacon, "magic" | "timestamp">): Promise<void> {
    if (this.started) {
      this.self = self;
      return;
    }
    this.self = self;
    this._collectLocalAddresses();

    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

      socket.on("error", (err) => {
        logger.warn("UDP socket error:", err);
      });

      socket.on("message", (buf, rinfo) => this._onMessage(buf, rinfo));

      socket.bind(PORT, () => {
        try {
          socket.setBroadcast(true);
        } catch (err) {
          logger.warn("setBroadcast failed (non-fatal):", err);
        }
        this.socket = socket;
        this.started = true;
        this.broadcastTimer = setInterval(
          () => this._broadcast(),
          BROADCAST_INTERVAL_MS,
        );
        this.staleTimer = setInterval(
          () => this._sweepStale(),
          BROADCAST_INTERVAL_MS,
        );
        // Send immediately
        this._broadcast();
        logger.info(`LAN discovery listening on UDP :${PORT}`);
        resolve();
      });

      socket.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.broadcastTimer) clearInterval(this.broadcastTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.broadcastTimer = null;
    this.staleTimer = null;
    const closing = new Promise<void>((resolve) => {
      this.socket?.close(() => resolve());
    });
    this.socket = null;
    this.started = false;
    this.peers.clear();
    await closing;
    logger.info("LAN discovery stopped");
  }

  getPeers(): LanPeer[] {
    return Array.from(this.peers.values());
  }

  /** Returns the IP address (or null) where we most recently heard from this peer. */
  getAddress(publicKey: string): string | null {
    return this.peers.get(publicKey)?.address ?? null;
  }

  private _broadcast(): void {
    if (!this.socket || !this.self) return;
    const beacon: LanBeacon = {
      magic: MAGIC,
      ...this.self,
      timestamp: Date.now(),
    };
    const payload = Buffer.from(JSON.stringify(beacon), "utf-8");

    // Broadcast to the global broadcast address AND to each interface's
    // subnet broadcast — some Wi-Fi drivers drop the global one.
    const targets = new Set<string>(["255.255.255.255"]);
    for (const addr of this._iterateBroadcastTargets()) targets.add(addr);

    for (const t of targets) {
      this.socket.send(payload, 0, payload.length, PORT, t, (err) => {
        if (err) {
          // EHOSTUNREACH / EADDRNOTAVAIL on offline interfaces is fine.
          if (
            !["EHOSTUNREACH", "EADDRNOTAVAIL", "ENETUNREACH"].includes(
              (err as NodeJS.ErrnoException).code ?? "",
            )
          ) {
            logger.warn(`UDP send to ${t} failed:`, err.message);
          }
        }
      });
    }
  }

  private *_iterateBroadcastTargets(): Generator<string> {
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      if (!list) continue;
      for (const iface of list) {
        if (iface.family !== "IPv4" || iface.internal) continue;
        const broadcast = computeBroadcast(iface.address, iface.netmask);
        if (broadcast) yield broadcast;
      }
    }
  }

  private _collectLocalAddresses(): void {
    this.localAddresses.clear();
    const ifaces = os.networkInterfaces();
    for (const list of Object.values(ifaces)) {
      if (!list) continue;
      for (const iface of list) {
        if (iface.family === "IPv4") this.localAddresses.add(iface.address);
      }
    }
    this.localAddresses.add("127.0.0.1");
  }

  private _onMessage(buf: Buffer, rinfo: dgram.RemoteInfo): void {
    if (!this.self) return;
    let beacon: LanBeacon;
    try {
      beacon = JSON.parse(buf.toString("utf-8")) as LanBeacon;
    } catch {
      return;
    }
    if (beacon.magic !== MAGIC) return;
    // Ignore our own beacons (would echo from broadcast)
    if (beacon.publicKey === this.self.publicKey) return;
    if (
      typeof beacon.publicKey !== "string" ||
      beacon.publicKey.length < 16 ||
      beacon.publicKey.length > 128
    ) {
      return;
    }

    const existing = this.peers.get(beacon.publicKey);
    const peer: LanPeer = {
      publicKey: beacon.publicKey,
      displayName: beacon.displayName,
      deviceName: beacon.deviceName,
      address: rinfo.address,
      lastSeenAt: Date.now(),
    };
    this.peers.set(beacon.publicKey, peer);
    if (!existing) {
      logger.info(
        `LAN peer: ${beacon.displayName} (${beacon.publicKey.slice(0, 16)}…) @ ${rinfo.address}`,
      );
    }
    this.emit("peer-seen", peer);
  }

  private _sweepStale(): void {
    const now = Date.now();
    for (const [key, peer] of this.peers) {
      if (now - peer.lastSeenAt > PEER_STALE_AFTER_MS) {
        this.peers.delete(key);
        this.emit("peer-lost", key);
        logger.info(
          `LAN peer lost: ${peer.displayName} (${key.slice(0, 16)}…)`,
        );
      }
    }
  }
}

function computeBroadcast(address: string, netmask: string): string | null {
  try {
    const aParts = address.split(".").map(Number);
    const mParts = netmask.split(".").map(Number);
    if (aParts.length !== 4 || mParts.length !== 4) return null;
    const broadcast = aParts.map((a, i) => (a | (~mParts[i] & 0xff)) & 0xff);
    return broadcast.join(".");
  } catch {
    return null;
  }
}

export const lanDiscovery = new LanDiscovery();
