export const ORION_SESSION_APP_NAME = "Orion Sessions";

/** The Orion session workspace is a durable chat/media container, not a user
 *  project with a preview server. It must never enter the app runtime. */
export function isOrionSessionAppId(
  appId: number,
  settings: { orionSessionAppId?: unknown },
): boolean {
  return settings.orionSessionAppId === appId;
}
