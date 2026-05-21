import crypto from "node:crypto";
import { safeStorage } from "electron";
import { getPublicKeyAsync, utils as ed25519Utils } from "@noble/ed25519";
import log from "electron-log";
import { db } from "@/db";
import { deviceIdentity } from "@/db/schema";

const logger = log.scope("identity:keypair");

export interface KeypairData {
  publicKey: string;
  fingerprint: string;
}

let _cache: KeypairData | null = null;

export async function getOrCreateKeypair(): Promise<KeypairData> {
  if (_cache) return _cache;

  const existing = db.select().from(deviceIdentity).limit(1).all();
  if (existing.length > 0) {
    const row = existing[0];
    _cache = {
      publicKey: row.publicKey,
      fingerprint: computeFingerprint(row.publicKey),
    };
    return _cache;
  }

  logger.info("Generating new Ed25519 keypair");
  const privKeyBytes = ed25519Utils.randomSecretKey();
  const pubKeyBytes = await getPublicKeyAsync(privKeyBytes);

  const pubKeyHex = Buffer.from(pubKeyBytes).toString("hex");
  const privKeyHex = Buffer.from(privKeyBytes).toString("hex");

  let encryptedPrivKey: string;
  if (safeStorage.isEncryptionAvailable()) {
    encryptedPrivKey = safeStorage.encryptString(privKeyHex).toString("base64");
  } else {
    logger.warn(
      "safeStorage unavailable, storing private key as plaintext (development only)",
    );
    encryptedPrivKey = Buffer.from(privKeyHex).toString("base64");
  }

  const os = await import("node:os");
  const hostname = os.hostname();

  db.insert(deviceIdentity)
    .values({
      publicKey: pubKeyHex,
      privateKeyEncrypted: encryptedPrivKey,
      deviceName: hostname,
      deviceType: "desktop",
    })
    .run();

  _cache = { publicKey: pubKeyHex, fingerprint: computeFingerprint(pubKeyHex) };
  return _cache;
}

export async function getPrivateKeyBytes(): Promise<Uint8Array> {
  const rows = db.select().from(deviceIdentity).limit(1).all();
  if (!rows.length) throw new Error("No keypair found");

  const encoded = rows[0].privateKeyEncrypted;
  const buf = Buffer.from(encoded, "base64");

  let privKeyHex: string;
  if (safeStorage.isEncryptionAvailable()) {
    privKeyHex = safeStorage.decryptString(buf);
  } else {
    privKeyHex = buf.toString("utf-8");
  }

  return Buffer.from(privKeyHex, "hex");
}

export function computeFingerprint(publicKeyHex: string): string {
  const pubBytes = Buffer.from(publicKeyHex, "hex");
  const hash = crypto.createHash("sha256").update(pubBytes).digest();
  return hash.slice(0, 8).toString("hex").toUpperCase();
}

export async function resetKeypair(): Promise<KeypairData> {
  db.delete(deviceIdentity).run();
  _cache = null;
  return getOrCreateKeypair();
}
