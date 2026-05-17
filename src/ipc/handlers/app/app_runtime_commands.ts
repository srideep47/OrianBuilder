/**
 * Helpers for resolving the per-app install/start command pair.
 *
 * - getDefaultCommand: the fallback command used when an app has no custom
 *   install/start configured. Tries pnpm first, falls back to npm.
 * - getTemplateRuntimeCommands: known overrides for specific templates (Expo,
 *   Electron) where the default doesn't fit.
 * - isStaleExpoRuntimeCommand / resolveRuntimeCommandsForApp: detects an
 *   outdated Expo command and migrates it to the new "npm run preview" flow.
 * - getCommand: composes a shell command from install/start parts.
 */

import { eq } from "drizzle-orm";
import log from "electron-log";

import { db } from "../../../db";
import { apps } from "../../../db/schema";
import { getAppPort } from "../../../../shared/ports";
import { detectProjectStack } from "../../utils/project_stack_detector";

const logger = log.scope("app_handlers");

export function getDefaultCommand(appId: number): string {
  const port = getAppPort(appId);
  return `(pnpm install && pnpm run dev --port ${port}) || (npm install --legacy-peer-deps && npm run dev -- --port ${port})`;
}

export function getTemplateRuntimeCommands(templateId?: string): {
  installCommand: string | null;
  startCommand: string | null;
} {
  if (
    templateId === "expo" ||
    templateId === "shaaraa/orianbuilder-react-native-expo-template"
  ) {
    return {
      installCommand: "npm install --legacy-peer-deps",
      startCommand: "npm run preview",
    };
  }

  if (templateId === "electron-app") {
    return {
      installCommand: "npm install --legacy-peer-deps",
      startCommand: "npm run dev",
    };
  }

  return { installCommand: null, startCommand: null };
}

export function isStaleExpoRuntimeCommand(command?: string | null): boolean {
  const normalized = command?.trim().toLowerCase();
  if (!normalized) return true;

  return (
    normalized === "npm run start" ||
    normalized.startsWith("npm run start --") ||
    normalized.includes("expo start") ||
    normalized.includes("--port 8081")
  );
}

export async function resolveRuntimeCommandsForApp({
  appPath,
  appId,
  installCommand,
  startCommand,
}: {
  appPath: string;
  appId: number;
  installCommand?: string | null;
  startCommand?: string | null;
}): Promise<{
  installCommand?: string | null;
  startCommand?: string | null;
}> {
  try {
    const stack = await detectProjectStack(appPath);
    if (
      stack.framework !== "expo" ||
      !stack.scripts.preview ||
      !stack.commands.dev ||
      !isStaleExpoRuntimeCommand(startCommand)
    ) {
      return { installCommand, startCommand };
    }

    const resolvedInstallCommand = stack.commands.install ?? installCommand;
    const resolvedStartCommand = stack.commands.dev;
    logger.info(
      `Updating Expo runtime commands for app ${appId}: start="${startCommand ?? ""}" -> "${resolvedStartCommand}"`,
    );

    await db
      .update(apps)
      .set({
        installCommand: resolvedInstallCommand,
        startCommand: resolvedStartCommand,
      })
      .where(eq(apps.id, appId));

    return {
      installCommand: resolvedInstallCommand,
      startCommand: resolvedStartCommand,
    };
  } catch (error) {
    logger.warn(
      `Could not detect project stack for app ${appId}; using stored runtime commands.`,
      error,
    );
    return { installCommand, startCommand };
  }
}

export function getCommand({
  appId,
  installCommand,
  startCommand,
}: {
  appId: number;
  installCommand?: string | null;
  startCommand?: string | null;
}): string {
  const hasCustomCommands = !!installCommand?.trim() && !!startCommand?.trim();
  return hasCustomCommands
    ? `${installCommand!.trim()} && ${startCommand!.trim()}`
    : getDefaultCommand(appId);
}
