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
    // Validate the stored private key is actually decryptable on THIS machine
    // before trusting the identity. safeStorage (Windows DPAPI / macOS Keychain
    // / Linux libsecret) is bound to the OS user + machine, so if the app data
    // folder was copied from another PC (a very common setup when running the
    // unpackaged app from a shared drive), the ciphertext can't be decrypted
    // here. Previously this made swarm.start() throw and silently disabled
    // networking forever (no socket bound → no firewall prompt). Heal it by
    // regenerating a fresh identity instead.
    if (tryDecodePrivateKey(row.privateKeyEncrypted)) {
      _cache = {
        publicKey: row.publicKey,
        fingerprint: computeFingerprint(row.publicKey),
      };
      return _cache;
    }
    logger.warn(
      "Device identity private key can't be decrypted on this machine " +
        "(safeStorage is per-user/per-machine; the app data was likely copied " +
        "from another PC). Regenerating a fresh identity so networking works.",
    );
    db.delete(deviceIdentity).run();
  }

  return generateAndPersistKeypair();
}

export async function getPrivateKeyBytes(): Promise<Uint8Array> {
  // Ensure the stored key is decryptable on this machine first (heals a key
  // copied from another PC), then read it back.
  await getOrCreateKeypair();

  const rows = db.select().from(deviceIdentity).limit(1).all();
  if (!rows.length) throw new Error("No keypair found");

  const bytes = tryDecodePrivateKey(rows[0].privateKeyEncrypted);
  if (bytes) return bytes;

  // Defensive: should not happen after getOrCreateKeypair healed it, but never
  // let an undecryptable key bubble up and disable networking.
  logger.warn("Private key still undecryptable after heal — regenerating");
  _cache = null;
  db.delete(deviceIdentity).run();
  await generateAndPersistKeypair();
  const fresh = db.select().from(deviceIdentity).limit(1).all();
  const b = fresh.length
    ? tryDecodePrivateKey(fresh[0].privateKeyEncrypted)
    : null;
  if (!b) throw new Error("Failed to materialize a usable device key");
  return b;
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

// ── internals ──────────────────────────────────────────────────────────────

async function generateAndPersistKeypair(): Promise<KeypairData> {
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

/**
 * Decode the stored private key into raw 32-byte seed form, or null if it
 * cannot be recovered on this machine. Tries safeStorage decryption first, then
 * a plaintext interpretation (dev / encryption-unavailable installs), and
 * validates the result is a 32-byte hex seed.
 */
function tryDecodePrivateKey(encoded: string): Buffer | null {
  const buf = Buffer.from(encoded, "base64");
  const candidates: string[] = [];
  if (safeStorage.isEncryptionAvailable()) {
    try {
      candidates.push(safeStorage.decryptString(buf));
    } catch {
      // Encrypted by a different machine/user — fall through to plaintext try.
    }
  }
  candidates.push(buf.toString("utf-8"));

  for (const hex of candidates) {
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      const bytes = Buffer.from(hex, "hex");
      if (bytes.length === 32) return bytes;
    }
  }
  return null;
}
