import { eq } from "drizzle-orm";
import { db } from "@/db";
import { trustedPeers, friendRequests } from "@/db/schema";
import { computeFingerprint } from "@/main/identity/keypair";
import type { FriendRequest } from "@/ipc/types/network";

export function isTrustedPeer(publicKey: string): boolean {
  const rows = db
    .select()
    .from(trustedPeers)
    .where(eq(trustedPeers.publicKey, publicKey))
    .all();
  return rows.length > 0;
}

export function addTrustedPeer(params: {
  publicKey: string;
  displayName: string;
  addedVia?: "invite" | "manual";
}): void {
  const fingerprint = computeFingerprint(params.publicKey);
  const existing = db
    .select()
    .from(trustedPeers)
    .where(eq(trustedPeers.publicKey, params.publicKey))
    .all();
  if (existing.length > 0) return;

  db.insert(trustedPeers)
    .values({
      publicKey: params.publicKey,
      fingerprint,
      displayName: params.displayName,
      addedVia: params.addedVia ?? "invite",
    })
    .run();
}

export function updatePeerLastSeen(publicKey: string): void {
  db.update(trustedPeers)
    .set({ lastSeenAt: new Date() })
    .where(eq(trustedPeers.publicKey, publicKey))
    .run();
}

export function removeTrustedPeer(publicKey: string): void {
  db.delete(trustedPeers).where(eq(trustedPeers.publicKey, publicKey)).run();
}

export function listTrustedPeers() {
  return db.select().from(trustedPeers).all();
}

export function createFriendRequest(params: {
  fromPublicKey: string;
  fromDisplayName: string;
  fromDeviceName: string;
}): number {
  const existing = db
    .select()
    .from(friendRequests)
    .where(eq(friendRequests.fromPublicKey, params.fromPublicKey))
    .all();
  if (existing.length > 0) return existing[0].id;

  const result = db
    .insert(friendRequests)
    .values({
      fromPublicKey: params.fromPublicKey,
      fromDisplayName: params.fromDisplayName,
      inviteCode: `${params.fromPublicKey.slice(0, 8)}`,
      status: "pending",
    })
    .returning()
    .all();

  return result[0]?.id ?? 0;
}

export function getPendingFriendRequests(): FriendRequest[] {
  const rows = db
    .select()
    .from(friendRequests)
    .where(eq(friendRequests.status, "pending"))
    .all();

  return rows.map((r) => ({
    id: r.id,
    fromPublicKey: r.fromPublicKey,
    fromDisplayName: r.fromDisplayName,
    fromDeviceName: r.fromDisplayName,
    status: r.status as "pending" | "accepted" | "declined",
    createdAt: r.createdAt instanceof Date ? r.createdAt.getTime() : Date.now(),
  }));
}

export function acceptFriendRequest(requestId: number): boolean {
  const rows = db
    .select()
    .from(friendRequests)
    .where(eq(friendRequests.id, requestId))
    .all();
  if (!rows.length || rows[0].status !== "pending") return false;

  const req = rows[0];
  db.update(friendRequests)
    .set({ status: "accepted" })
    .where(eq(friendRequests.id, requestId))
    .run();
  addTrustedPeer({
    publicKey: req.fromPublicKey,
    displayName: req.fromDisplayName,
  });
  return true;
}

export function declineFriendRequest(requestId: number): boolean {
  const rows = db
    .select()
    .from(friendRequests)
    .where(eq(friendRequests.id, requestId))
    .all();
  if (!rows.length) return false;
  db.update(friendRequests)
    .set({ status: "declined" })
    .where(eq(friendRequests.id, requestId))
    .run();
  return true;
}
