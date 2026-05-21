/**
 * Invite code generation and validation.
 * Format: ORION-[NAME]-[BASE62_TOKEN]
 * The token encodes a 128-bit random value that both sides use as a DHT rendezvous topic.
 */

import crypto from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory store of active invite tokens we generated
const activeInvites = new Map<string, { topic: Buffer; expiresAt: number }>();

function toBase62(buf: Buffer): string {
  let n = BigInt("0x" + buf.toString("hex"));
  const chars: string[] = [];
  while (n > 0n) {
    chars.unshift(BASE62[Number(n % 62n)]);
    n = n / 62n;
  }
  return chars.join("").padStart(22, "0");
}

function fromBase62(str: string): Buffer {
  let n = 0n;
  for (const c of str) {
    n = n * 62n + BigInt(BASE62.indexOf(c));
  }
  const hex = n.toString(16).padStart(32, "0");
  return Buffer.from(hex, "hex");
}

function sanitizeName(name: string): string {
  return (
    name
      .replace(/[^A-Z0-9]/gi, "")
      .slice(0, 10)
      .toUpperCase() || "PEER"
  );
}

export function generateInviteCode(displayName: string): {
  code: string;
  topic: Buffer;
  expiresAt: number;
} {
  const token = crypto.randomBytes(16);
  const topic = crypto
    .createHash("sha256")
    .update("orion-invite-")
    .update(token)
    .digest();
  const expiresAt = Date.now() + INVITE_TTL_MS;
  const code = `ORION-${sanitizeName(displayName)}-${toBase62(token)}`;

  activeInvites.set(code, { topic, expiresAt });

  // Auto-expire
  setTimeout(() => activeInvites.delete(code), INVITE_TTL_MS);

  return { code, topic, expiresAt };
}

export function parseInviteCode(code: string): { topic: Buffer } | null {
  const parts = code.trim().toUpperCase().split("-");
  // ORION - NAME - TOKEN (token is the last part, may contain dashes after NAME)
  if (parts.length < 3 || parts[0] !== "ORION") return null;
  const tokenStr = parts[parts.length - 1];
  try {
    const token = fromBase62(
      tokenStr
        .toLowerCase()
        .replace(/[^0-9a-z]/g, "")
        .padStart(22, "0"),
    );
    const topic = crypto
      .createHash("sha256")
      .update("orion-invite-")
      .update(token)
      .digest();
    return { topic };
  } catch {
    return null;
  }
}

export function getActiveInvites(): Map<
  string,
  { topic: Buffer; expiresAt: number }
> {
  return activeInvites;
}
