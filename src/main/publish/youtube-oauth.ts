/**
 * Google OAuth 2.0 loopback flow for YouTube publishing.
 *
 * Uses the "installed/desktop app" flow: we spin up a throwaway HTTP server on
 * 127.0.0.1 with an ephemeral port, send the user to Google's consent screen in
 * their real browser, and catch the redirect back to the loopback address to
 * read the authorization `code`. PKCE (S256) is used in addition to the client
 * secret so the flow is robust even for clients that require it.
 *
 * Scopes:
 *   youtube.upload   — needed to insert videos
 *   youtube.readonly — needed to read the channel title for display
 *
 * Note: while a Google Cloud project is unverified, the OAuth screen warns the
 * user and uploaded videos are forced to "private" by Google regardless of the
 * requested privacyStatus. Going public requires Google's app verification.
 */
import http from "node:http";
import crypto from "node:crypto";
import { shell, net } from "electron";
import log from "electron-log/main";
import {
  getCredentials,
  getAuth,
  saveTokens,
  setChannelTitle,
} from "./youtube-store";

const logger = log.scope("youtube-oauth");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
].join(" ");

const OAUTH_TIMEOUT_MS = 5 * 60_000;

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
  error?: string;
  error_description?: string;
}

async function exchangeToken(
  params: Record<string, string>,
): Promise<TokenResponse> {
  const res = await net.fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || data.error) {
    throw new Error(
      `Google token request failed: ${data.error ?? res.status} ${
        data.error_description ?? ""
      }`.trim(),
    );
  }
  return data;
}

/**
 * Returns a valid access token, refreshing it via the stored refresh token if
 * the current one is missing or within 60s of expiry. Throws if the user isn't
 * connected.
 */
export async function getValidAccessToken(): Promise<string> {
  const auth = getAuth();
  if (!auth) {
    throw new Error("YouTube is not configured. Add OAuth credentials first.");
  }
  if (!auth.refreshToken) {
    throw new Error(
      "YouTube account is not connected. Connect a channel in Settings.",
    );
  }
  const stillValid =
    auth.accessToken &&
    auth.accessTokenExpiresAt &&
    auth.accessTokenExpiresAt - Date.now() > 60_000;
  if (stillValid && auth.accessToken) return auth.accessToken;

  logger.info("Refreshing YouTube access token");
  const data = await exchangeToken({
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    refresh_token: auth.refreshToken,
    grant_type: "refresh_token",
  });
  saveTokens({
    accessToken: data.access_token,
    expiresInSeconds: data.expires_in,
    refreshToken: data.refresh_token,
  });
  return data.access_token;
}

/** Fetch the connected channel's title for display. Best-effort. */
async function fetchChannelTitle(accessToken: string): Promise<string | null> {
  try {
    const res = await net.fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: { snippet?: { title?: string } }[];
    };
    return data.items?.[0]?.snippet?.title ?? null;
  } catch {
    return null;
  }
}

/**
 * Run the full interactive OAuth flow. Opens the system browser, waits for the
 * loopback redirect, exchanges the code, persists tokens, and records the
 * channel title. Returns the connected channel title (may be null).
 */
export async function runOAuthFlow(): Promise<string | null> {
  const creds = getCredentials();
  if (!creds) {
    throw new Error(
      "Add your Google OAuth Client ID and Secret before connecting.",
    );
  }

  const state = base64Url(crypto.randomBytes(16));
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = base64Url(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  );

  return new Promise<string | null>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      fn();
    };

    const server = http.createServer((req, res) => {
      // Only handle the redirect path; ignore favicon etc.
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
        res.writeHead(204);
        res.end();
        return;
      }

      const respond = (message: string) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>OrianBuilder</title></head>` +
            `<body style="font-family:system-ui;background:#0b0b0d;color:#eee;display:flex;` +
            `align-items:center;justify-content:center;height:100vh;margin:0">` +
            `<div style="text-align:center"><h2>${message}</h2>` +
            `<p style="color:#999">You can close this tab and return to OrianBuilder.</p></div></body></html>`,
        );
      };

      const error = url.searchParams.get("error");
      if (error) {
        respond("Connection cancelled");
        finish(() => reject(new Error(`Google denied access: ${error}`)));
        return;
      }
      const returnedState = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (returnedState !== state || !code) {
        respond("Something went wrong");
        finish(() =>
          reject(new Error("OAuth state mismatch — please try connecting again.")),
        );
        return;
      }

      respond("YouTube connected ✓");
      const port = (server.address() as { port: number }).port;
      const redirectUri = `http://127.0.0.1:${port}`;
      void (async () => {
        try {
          const data = await exchangeToken({
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            code,
            code_verifier: codeVerifier,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
          });
          if (!data.refresh_token) {
            throw new Error(
              "Google did not return a refresh token. Remove OrianBuilder from " +
                "your Google account's third-party access and connect again.",
            );
          }
          saveTokens({
            accessToken: data.access_token,
            expiresInSeconds: data.expires_in,
            refreshToken: data.refresh_token,
          });
          const title = await fetchChannelTitle(data.access_token);
          setChannelTitle(title);
          finish(() => resolve(title));
        } catch (err) {
          finish(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
      })();
    });

    server.on("error", (err) =>
      finish(() => reject(new Error(`Could not start local OAuth server: ${err.message}`))),
    );

    const timeout = setTimeout(
      () =>
        finish(() =>
          reject(new Error("Timed out waiting for Google sign-in (5 min).")),
        ),
      OAUTH_TIMEOUT_MS,
    );

    // Listen on an ephemeral loopback port, then build the auth URL with the
    // resolved port as the redirect target.
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const authUrl =
        `${AUTH_ENDPOINT}?` +
        new URLSearchParams({
          client_id: creds.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPES,
          access_type: "offline",
          prompt: "consent",
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        }).toString();
      logger.info(`Opening Google consent screen (loopback :${port})`);
      void shell.openExternal(authUrl);
    });
  });
}
