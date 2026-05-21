import { z } from "zod";
import {
  defineContract,
  defineEvent,
  createClient,
  createEventClient,
} from "../contracts/core";

// =============================================================================
// Schemas
// =============================================================================

export const PeerHardwareSchema = z.object({
  cpu: z.string(),
  ramGB: z.number(),
  gpu: z.string(),
  vramGB: z.number(),
});

export const PeerStatusSchema = z.enum(["online", "offline", "connecting"]);

export const PeerSchema = z.object({
  publicKey: z.string(), // hex Ed25519 public key
  fingerprint: z.string(), // first 8 bytes SHA-256 as HEX
  displayName: z.string(),
  deviceName: z.string(),
  deviceType: z.enum(["desktop", "laptop", "server"]),
  hardware: PeerHardwareSchema.nullable(),
  status: PeerStatusSchema,
  isTrusted: z.boolean(),
  isLan: z.boolean(),
  latencyMs: z.number().nullable(),
  lastSeenAt: z.number().nullable(),
  loadedModels: z.array(z.string()),
  gpuUtilization: z.number(),
  computeAvailable: z.boolean(),
  appVersion: z.string(),
});
export type Peer = z.infer<typeof PeerSchema>;
export type PeerStatus = z.infer<typeof PeerStatusSchema>;

export const NetworkStatusSchema = z.object({
  isOnline: z.boolean(),
  peerCount: z.number(),
  trustedPeerCount: z.number(),
  peers: z.array(PeerSchema),
});
export type NetworkStatus = z.infer<typeof NetworkStatusSchema>;

export const InviteCodeResultSchema = z.object({
  code: z.string(),
  expiresAt: z.number(),
});

export const RedeemInviteResultSchema = z.object({
  status: z.enum(["connecting", "already_friend", "request_sent"]),
  message: z.string(),
});

export const FriendRequestSchema = z.object({
  id: z.number(),
  fromPublicKey: z.string(),
  fromDisplayName: z.string(),
  fromDeviceName: z.string(),
  status: z.enum(["pending", "accepted", "declined"]),
  createdAt: z.number(),
});
export type FriendRequest = z.infer<typeof FriendRequestSchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  type: z.enum([
    "peer_online",
    "peer_offline",
    "friend_request",
    "friend_accepted",
    "compute_active",
    "compute_done",
  ]),
  title: z.string(),
  body: z.string(),
  timestamp: z.number(),
  read: z.boolean(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type Notification = z.infer<typeof NotificationSchema>;

// =============================================================================
// Contracts
// =============================================================================

export const networkContracts = {
  getStatus: defineContract({
    channel: "network:get-status",
    input: z.void(),
    output: NetworkStatusSchema,
  }),
  setOnline: defineContract({
    channel: "network:set-online",
    input: z.object({ online: z.boolean() }),
    output: z.object({ isOnline: z.boolean() }),
  }),
  getPeer: defineContract({
    channel: "network:get-peer",
    input: z.object({ publicKey: z.string() }),
    output: PeerSchema.nullable(),
  }),
  generateInvite: defineContract({
    channel: "network:generate-invite",
    input: z.void(),
    output: InviteCodeResultSchema,
  }),
  redeemInvite: defineContract({
    channel: "network:redeem-invite",
    input: z.object({ code: z.string() }),
    output: RedeemInviteResultSchema,
  }),
  getFriendRequests: defineContract({
    channel: "network:get-friend-requests",
    input: z.void(),
    output: z.array(FriendRequestSchema),
  }),
  acceptFriendRequest: defineContract({
    channel: "network:accept-friend-request",
    input: z.object({ requestId: z.number() }),
    output: z.object({ success: z.boolean() }),
  }),
  declineFriendRequest: defineContract({
    channel: "network:decline-friend-request",
    input: z.object({ requestId: z.number() }),
    output: z.object({ success: z.boolean() }),
  }),
  removeFriend: defineContract({
    channel: "network:remove-friend",
    input: z.object({ publicKey: z.string() }),
    output: z.object({ success: z.boolean() }),
  }),
  sendFriendRequest: defineContract({
    channel: "network:send-friend-request",
    input: z.object({ publicKey: z.string() }),
    output: z.object({ success: z.boolean() }),
  }),
  getNotifications: defineContract({
    channel: "network:get-notifications",
    input: z.void(),
    output: z.array(NotificationSchema),
  }),
  markNotificationsRead: defineContract({
    channel: "network:mark-notifications-read",
    input: z.void(),
    output: z.object({ success: z.boolean() }),
  }),
} as const;

export const networkClient = createClient(networkContracts);

// =============================================================================
// Events (main → renderer)
// =============================================================================

export const networkEvents = {
  peerUpdate: defineEvent({
    channel: "network:event:peer-update",
    payload: z.object({ peers: z.array(PeerSchema) }),
  }),
  notification: defineEvent({
    channel: "network:event:notification",
    payload: NotificationSchema,
  }),
  friendRequest: defineEvent({
    channel: "network:event:friend-request",
    payload: FriendRequestSchema,
  }),
} as const;

export const networkEventClient = createEventClient(networkEvents);
