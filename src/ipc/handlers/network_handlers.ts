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

  createTypedHandler(
    networkContracts.testPeer,
    async (_event, { publicKey }) => {
      const start = Date.now();
      if (!networkSwarm.isPeerConnected(publicKey)) {
        return {
          ok: false,
          step: "connection",
          detail: `Peer ${publicKey.slice(0, 16)}… is not connected. Go to Network and verify both devices show as online.`,
        };
      }

      networkSwarm.requestPeerRefresh(publicKey);

      const requestId = crypto.randomUUID();
      const testBody = JSON.stringify({
        model: "test",
        messages: [
          {
            role: "user",
            // Qwen3 / DeepSeek-R1 reasoning models burn 100+ tokens thinking
            // before they answer. 256 gives them room to produce something
            // visible; we only display the first 500 chars in the UI anyway.
            content: "Say hi.",
          },
        ],
        stream: true,
        max_tokens: 256,
        temperature: 0,
      });

      return new Promise((resolve) => {
        let collected = "";
        let rawSample = "";
        const seenFields = new Set<string>();
        let bytes = 0;
        let finished = false;
        const timeout = setTimeout(() => {
          if (finished) return;
          finished = true;
          cleanup?.();
          resolve({
            ok: false,
            step: "stream-timeout",
            detail:
              "No response within 30 s. The peer's embedded engine may be loading or stuck.",
            output: rawSample.slice(0, 1500),
            bytes,
            durationMs: Date.now() - start,
          });
        }, 30_000);

        const cleanup = networkSwarm.sendInferenceRequest(
          publicKey,
          requestId,
          testBody,
          (chunk) => {
            bytes += chunk.length;
            if (rawSample.length < 2000) {
              rawSample += chunk;
            }
            for (const line of chunk.split("\n")) {
              const t = line.trim();
              if (!t.startsWith("data: ") || t === "data: [DONE]") continue;
              try {
                const json = JSON.parse(t.slice(6));
                const delta = json?.choices?.[0]?.delta;
                if (delta && typeof delta === "object") {
                  for (const k of Object.keys(delta)) seenFields.add(k);
                }
                // Try every known content-bearing field
                const fromContent = delta?.content;
                const fromReasoning = delta?.reasoning_content;
                const fromText = json?.choices?.[0]?.text;
                if (typeof fromContent === "string") collected += fromContent;
                if (typeof fromReasoning === "string")
                  collected += fromReasoning;
                if (typeof fromText === "string") collected += fromText;
              } catch {}
            }
          },
          (err) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            const fieldsSeen = Array.from(seenFields).join(", ") || "(none)";
            if (err) {
              resolve({
                ok: false,
                step: "remote-error",
                detail: err,
                output: rawSample.slice(0, 1500),
                bytes,
                durationMs: Date.now() - start,
              });
            } else if (bytes === 0) {
              resolve({
                ok: false,
                step: "empty-stream",
                detail:
                  "Peer returned 0 bytes. Check electron-log on the host device — look for [recv] lines from compute:node.",
                bytes,
                durationMs: Date.now() - start,
              });
            } else if (collected.length === 0) {
              resolve({
                ok: false,
                step: "no-content-deltas",
                detail: `Streamed ${bytes} bytes back but no delta.content / delta.reasoning_content / text fields were populated. Delta fields seen: ${fieldsSeen}. Raw SSE is below — look for where the actual tokens are.`,
                output: rawSample.slice(0, 1500),
                bytes,
                durationMs: Date.now() - start,
              });
            } else {
              resolve({
                ok: true,
                step: "success",
                detail: `Round-trip successful. ${bytes} bytes, ${collected.length} chars of content extracted from fields: ${fieldsSeen}.`,
                output: `CONTENT: ${collected.slice(0, 500)}\n\n---RAW SSE---\n${rawSample.slice(0, 1000)}`,
                bytes,
                durationMs: Date.now() - start,
              });
            }
          },
        );

        if (!cleanup) {
          finished = true;
          clearTimeout(timeout);
          resolve({
            ok: false,
            step: "send-failed",
            detail: "Failed to send request — peer channel closed.",
          });
        }
      });
    },
  );

  createTypedHandler(networkContracts.getDiagnostic, async (_event) => {
    const { getCurrentBroadcastState } =
      await import("@/main/compute/load-monitor");
    const { getServerStatus } =
      await import("@/ipc/utils/embedded_inference_server");
    const identity = await getDeviceIdentity();
    const snapshot = getCurrentBroadcastState();
    const embedded = getServerStatus();
    const { peers } = networkSwarm.getStatus();

    return {
      self: {
        publicKey: identity.publicKey,
        displayName: identity.deviceName,
        embeddedModelLoaded: embedded.modelLoaded,
        embeddedModelName: embedded.modelName,
        shareEnabled: snapshot.computeAvailable,
        lastBroadcast: {
          timestamp: snapshot.timestamp,
          loadedModels: snapshot.loadedModels,
          computeAvailable: snapshot.computeAvailable,
          gpuUtilization: snapshot.gpuUtilization,
        },
      },
      peers: peers.map((p) => {
        const detail = networkSwarm.getPeerDetail(p.publicKey);
        return {
          publicKey: p.publicKey,
          displayName: p.displayName,
          isConnected: detail?.isConnected ?? false,
          lastSeenAt: detail?.lastSeenAt ?? null,
          lastLoadUpdateAt: detail?.lastLoadUpdateAt ?? null,
          latencyMs: p.latencyMs,
          loadedModels: p.loadedModels,
          computeAvailable: p.computeAvailable,
        };
      }),
    };
  });

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
