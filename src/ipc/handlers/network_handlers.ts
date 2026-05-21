import { BrowserWindow } from "electron";
import log from "electron-log";
import {
  networkContracts,
  networkEvents,
  type Notification,
} from "../types/network";
import { createTypedHandler } from "./base";
import { networkSwarm } from "@/main/network/swarm";
import { generateInviteCode, parseInviteCode } from "@/main/network/invite";
import {
  getPendingFriendRequests,
  getFriendRequestById,
  acceptFriendRequest,
  declineFriendRequest,
  removeTrustedPeer,
  listTrustedPeers,
} from "@/main/network/friends";
import { getDeviceIdentity } from "@/main/identity/device";
import { readSettings, writeSettings } from "@/main/settings";
import crypto from "node:crypto";

const logger = log.scope("network:handlers");

// In-memory notifications (ephemeral, cleared on restart)
const notifications: Notification[] = [];

function safeSendToAll(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function addNotification(
  type: Notification["type"],
  title: string,
  body: string,
  meta?: Record<string, unknown>,
) {
  const notif: Notification = {
    id: crypto.randomUUID(),
    type,
    title,
    body,
    timestamp: Date.now(),
    read: false,
    meta,
  };
  notifications.unshift(notif);
  if (notifications.length > 50) notifications.pop();
  safeSendToAll(networkEvents.notification.channel, notif);
  return notif;
}

export function registerNetworkHandlers(): void {
  // Wire swarm events → IPC events
  networkSwarm.on("peers-changed", (peers) => {
    safeSendToAll(networkEvents.peerUpdate.channel, { peers });
  });

  networkSwarm.on("notification", (type, title, body, meta) => {
    addNotification(type as Notification["type"], title, body, meta);
  });

  networkSwarm.on("friend-request", (req) => {
    safeSendToAll(networkEvents.friendRequest.channel, {
      id: 0,
      fromPublicKey: req.fromPublicKey,
      fromDisplayName: req.fromDisplayName,
      fromDeviceName: req.fromDeviceName,
      status: "pending",
      createdAt: Date.now(),
    });
    addNotification(
      "friend_request",
      `Friend request from ${req.fromDisplayName}`,
      "Accept or decline in Network",
    );
  });

  // ── Contracts ──

  createTypedHandler(networkContracts.getStatus, async (_event) => {
    const { isOnline, peers } = networkSwarm.getStatus();
    const trusted = listTrustedPeers();
    return {
      isOnline,
      peerCount: peers.length,
      trustedPeerCount: trusted.length,
      peers: peers.map((p) => ({
        ...p,
        fingerprint: p.publicKey.slice(0, 16).toUpperCase(),
      })),
    };
  });

  createTypedHandler(networkContracts.setOnline, async (_event, { online }) => {
    const settings = readSettings() as any;
    writeSettings({ ...settings, orionNetworkEnabled: online });

    if (online) {
      await networkSwarm
        .start()
        .catch((err) => logger.error("Start failed:", err));
    } else {
      await networkSwarm.stop();
    }
    return { isOnline: networkSwarm.getStatus().isOnline };
  });

  createTypedHandler(
    networkContracts.getPeer,
    async (_event, { publicKey }) => {
      const { peers } = networkSwarm.getStatus();
      return peers.find((p) => p.publicKey === publicKey) ?? null;
    },
  );

  createTypedHandler(networkContracts.generateInvite, async (_event) => {
    const identity = await getDeviceIdentity();
    const { code, topic, expiresAt } = generateInviteCode(identity.deviceName);
    await networkSwarm
      .joinInviteTopic(topic)
      .catch((err) => logger.warn("joinInviteTopic failed:", err));
    return { code, expiresAt };
  });

  createTypedHandler(
    networkContracts.redeemInvite,
    async (_event, { code }) => {
      const parsed = parseInviteCode(code);
      if (!parsed) throw new Error("Invalid invite code format");

      const { peers } = networkSwarm.getStatus();
      const found = peers.find((p) => p.isTrusted);
      if (found)
        return {
          status: "already_friend" as const,
          message: "Already connected",
        };

      await networkSwarm.joinInviteTopic(parsed.topic);
      return {
        status: "connecting" as const,
        message: "Searching for peer — keep both apps open…",
      };
    },
  );

  createTypedHandler(networkContracts.getFriendRequests, async (_event) => {
    return getPendingFriendRequests();
  });

  createTypedHandler(
    networkContracts.acceptFriendRequest,
    async (_event, { requestId }) => {
      // Get the request BEFORE accepting — status changes after accept
      const req = getFriendRequestById(requestId);
      const ok = acceptFriendRequest(requestId);
      // Notify the peer that we accepted and update in-memory trusted state
      if (req && ok) {
        networkSwarm.notifyFriendAccepted(req.fromPublicKey);
        addNotification(
          "friend_accepted",
          `You are now friends with ${req.fromDisplayName}`,
          "They can now share compute with you",
        );
      }
      return { success: ok };
    },
  );

  createTypedHandler(
    networkContracts.declineFriendRequest,
    async (_event, { requestId }) => {
      return { success: declineFriendRequest(requestId) };
    },
  );

  createTypedHandler(
    networkContracts.removeFriend,
    async (_event, { publicKey }) => {
      removeTrustedPeer(publicKey);
      return { success: true };
    },
  );

  createTypedHandler(
    networkContracts.sendFriendRequest,
    async (_event, { publicKey }) => {
      try {
        networkSwarm.sendFriendRequest(publicKey);
        return { success: true };
      } catch (err) {
        throw new Error(
          err instanceof Error ? err.message : "Peer not connected",
        );
      }
    },
  );

  createTypedHandler(
    networkContracts.refreshPeer,
    async (_event, { publicKey }) => {
      const ok = networkSwarm.requestPeerRefresh(publicKey);
      return { success: ok };
    },
  );

  createTypedHandler(networkContracts.getNotifications, async (_event) => {
    return notifications;
  });

  createTypedHandler(networkContracts.markNotificationsRead, async (_event) => {
    for (const n of notifications) n.read = true;
    return { success: true };
  });

  // Auto-start if enabled
  const settings = readSettings() as any;
  if (settings.orionNetworkEnabled !== false) {
    networkSwarm
      .start()
      .catch((err) => logger.error("Auto-start failed:", err));
  }
}
