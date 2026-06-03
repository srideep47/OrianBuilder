/**
 * Persistent storage for the user's YouTube publishing connection.
 *
 * The model is "bring your own" Google OAuth credentials: the user creates a
 * Desktop-app OAuth client in Google Cloud once, pastes the Client ID + Secret
 * here, then connects their channel via the loopback OAuth flow (see
 * youtube-oauth.ts). We persist the long-lived refresh token so the connection
 * survives restarts; the short-lived access token is refreshed on demand.
 *
 * Everything lives in a single JSON file under `userData/youtube-publish.json`.
 * Secret fields (client secret + tokens) are encrypted with Electron's
 * safeStorage, exactly like the integration tokens in main/settings.ts.
 */
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import log from "electron-log/main";
import { encrypt, decrypt } from "@/main/settings";
import type { Secret } from "@/lib/schemas";

const logger = log.scope("youtube-store");

interface StoredYouTube {
  clientId?: string | null;
  clientSecret?: Secret | null;
  refreshToken?: Secret | null;
  accessToken?: Secret | null;
  /** Epoch ms when the access token expires. */
  accessTokenExpiresAt?: number | null;
  /** Title of the connected channel, for display. */
  channelTitle?: string | null;
}

/** Decrypted, in-memory view used by the rest of the publish code. */
export interface YouTubeAuth {
  clientId: string;
  clientSecret: string;
  refreshToken: string | null;
  accessToken: string | null;
  accessTokenExpiresAt: number | null;
  channelTitle: string | null;
}

function storeFile(): string {
  return path.join(app.getPath("userData"), "youtube-publish.json");
}

function readRaw(): StoredYouTube {
  try {
    const p = storeFile();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8")) as StoredYouTube;
  } catch (err) {
    logger.warn("Failed to read youtube store:", err);
    return {};
  }
}

function writeRaw(patch: Partial<StoredYouTube>): void {
  try {
    const merged = { ...readRaw(), ...patch };
    fs.writeFileSync(storeFile(), JSON.stringify(merged, null, 2), "utf-8");
  } catch (err) {
    logger.error("Failed to write youtube store:", err);
    throw err;
  }
}

function decryptOrNull(secret: Secret | null | undefined): string | null {
  if (!secret) return null;
  try {
    return decrypt(secret);
  } catch (err) {
    logger.warn("Failed to decrypt youtube secret:", err);
    return null;
  }
}

/** Save the BYO OAuth client credentials. Clears any existing connection
 *  tokens since they belong to the previous client. */
export function saveCredentials(clientId: string, clientSecret: string): void {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!id || !secret) {
    throw new Error("Both Client ID and Client Secret are required.");
  }
  writeRaw({
    clientId: id,
    clientSecret: encrypt(secret),
    // Reset any prior connection — tokens are tied to the old client.
    refreshToken: null,
    accessToken: null,
    accessTokenExpiresAt: null,
    channelTitle: null,
  });
  logger.info("Saved YouTube OAuth client credentials");
}

/** Returns the decrypted client credentials, or null if not configured. */
export function getCredentials(): { clientId: string; clientSecret: string } | null {
  const raw = readRaw();
  const clientSecret = decryptOrNull(raw.clientSecret);
  if (!raw.clientId || !clientSecret) return null;
  return { clientId: raw.clientId, clientSecret };
}

/** Persist tokens after a successful OAuth exchange or refresh. A refresh
 *  response often omits the refresh token — only overwrite it when present. */
export function saveTokens(opts: {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken?: string | null;
}): void {
  const patch: Partial<StoredYouTube> = {
    accessToken: encrypt(opts.accessToken),
    accessTokenExpiresAt: Date.now() + opts.expiresInSeconds * 1000,
  };
  if (opts.refreshToken) {
    patch.refreshToken = encrypt(opts.refreshToken);
  }
  writeRaw(patch);
}

export function setChannelTitle(title: string | null): void {
  writeRaw({ channelTitle: title });
}

/** Full decrypted auth state. Null if no client credentials are configured. */
export function getAuth(): YouTubeAuth | null {
  const raw = readRaw();
  const clientSecret = decryptOrNull(raw.clientSecret);
  if (!raw.clientId || !clientSecret) return null;
  return {
    clientId: raw.clientId,
    clientSecret,
    refreshToken: decryptOrNull(raw.refreshToken),
    accessToken: decryptOrNull(raw.accessToken),
    accessTokenExpiresAt: raw.accessTokenExpiresAt ?? null,
    channelTitle: raw.channelTitle ?? null,
  };
}

/** Wipe the entire connection (credentials + tokens). */
export function clearAll(): void {
  try {
    const p = storeFile();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    logger.info("Cleared YouTube connection");
  } catch (err) {
    logger.warn("Failed to clear youtube store:", err);
  }
}

export interface YouTubeStatus {
  /** Client ID + Secret have been saved. */
  hasCredentials: boolean;
  /** A channel is connected (we hold a refresh token). */
  connected: boolean;
  channelTitle: string | null;
}

export function getStatus(): YouTubeStatus {
  const raw = readRaw();
  const hasCredentials = !!raw.clientId && !!raw.clientSecret;
  const connected = hasCredentials && !!raw.refreshToken;
  return {
    hasCredentials,
    connected,
    channelTitle: connected ? (raw.channelTitle ?? null) : null,
  };
}
