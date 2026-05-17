import log from "electron-log";
import { z } from "zod";

const logger = log.scope("remote_desktop_config");

const REMOTE_DESKTOP_CONFIG_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const FAILURE_CACHE_TTL_MS = 30 * 1000;

const RemoteDesktopConfigSchema = z.object({
  version: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  defaults: z
    .object({
      blockUnsafeNpmPackages: z.boolean().optional(),
    })
    .optional(),
});

export type RemoteDesktopConfig = z.infer<typeof RemoteDesktopConfigSchema>;

type RemoteDesktopConfigCacheEntry = {
  config: RemoteDesktopConfig | null;
  expiresAt: number;
};

let remoteDesktopConfigCache: RemoteDesktopConfigCacheEntry | null = null;
let remoteDesktopConfigFetchPromise: Promise<RemoteDesktopConfig | null> | null =
  null;
// Tracks how many consecutive fetches have failed. The first failure logs at
// `warn`; subsequent ones drop to `debug` so the log isn't spammed with the
// same "fetch failed" message every cache-miss interval when the user is
// offline. Reset to 0 on success — the next failure after a recovery will
// warn again.
let remoteDesktopConfigConsecutiveFailures = 0;

function getRemoteDesktopConfigUrl() {
  if (process.env.ORIANBUILDER_DESKTOP_CONFIG_URL) {
    return process.env.ORIANBUILDER_DESKTOP_CONFIG_URL;
  }

  return "https://api.orianbuilder.sh/v1/desktop-config";
}

async function fetchRemoteDesktopConfig(): Promise<RemoteDesktopConfig | null> {
  const response = await fetch(getRemoteDesktopConfigUrl(), {
    signal: AbortSignal.timeout(REMOTE_DESKTOP_CONFIG_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Desktop config request failed with status ${response.status}`,
    );
  }

  const json = await response.json();
  return RemoteDesktopConfigSchema.parse(json);
}

export async function getRemoteDesktopConfig(): Promise<RemoteDesktopConfig | null> {
  if (
    remoteDesktopConfigCache &&
    remoteDesktopConfigCache.expiresAt > Date.now()
  ) {
    return remoteDesktopConfigCache.config;
  }

  if (!remoteDesktopConfigFetchPromise) {
    remoteDesktopConfigFetchPromise = (async () => {
      try {
        const config = await fetchRemoteDesktopConfig();
        if (remoteDesktopConfigConsecutiveFailures > 0) {
          logger.info(
            `Remote desktop config fetch recovered after ${remoteDesktopConfigConsecutiveFailures} consecutive failure(s)`,
          );
          remoteDesktopConfigConsecutiveFailures = 0;
        }
        remoteDesktopConfigCache = {
          config,
          expiresAt: config?.expiresAt
            ? Date.parse(config.expiresAt)
            : Date.now() + DEFAULT_CACHE_TTL_MS,
        };
        return config;
      } catch (error) {
        remoteDesktopConfigConsecutiveFailures += 1;
        if (remoteDesktopConfigConsecutiveFailures === 1) {
          logger.warn("Failed to fetch remote desktop config", error);
        } else {
          logger.debug(
            `Failed to fetch remote desktop config (${remoteDesktopConfigConsecutiveFailures} consecutive failures; further failures suppressed)`,
            error,
          );
        }
        remoteDesktopConfigCache = {
          config: null,
          expiresAt: Date.now() + FAILURE_CACHE_TTL_MS,
        };
        return null;
      } finally {
        remoteDesktopConfigFetchPromise = null;
      }
    })();
  }

  return remoteDesktopConfigFetchPromise;
}
