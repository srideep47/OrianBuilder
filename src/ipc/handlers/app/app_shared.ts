import { db } from "../../../db";
import { apps } from "../../../db/schema";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { getOrianBuilderAppPath } from "../../../paths/paths";
import { spawn } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import { withLock } from "../../utils/lock_utils";
import {
  runningApps,
  processCounter,
  removeAppIfCurrentProcess,
  stopAppByInfo,
} from "../../utils/process_manager";
import { readSettings } from "../../../main/settings";
import { addLog } from "../../../lib/log_store";
import { SCREENSHOT_FILENAME_REGEX } from "../../utils/media_path_utils";
import fixPath from "fix-path";
import killPort from "kill-port";
import log from "electron-log";
import { createLoggedHandler } from "../safe_handle";
import { startProxy } from "../../utils/start_proxy_server";
import {
  buildCloudSandboxFileMap,
  CloudSandboxApiError,
  createCloudSandbox,
  destroyCloudSandbox,
  registerRunningCloudSandbox,
  setCloudSandboxSyncUpdateListener,
  streamCloudSandboxLogs,
  uploadCloudSandboxFiles,
} from "../../utils/cloud_sandbox_provider";
import { safeSend } from "../../utils/safe_sender";
import type { RuntimeMode2 } from "@/lib/schemas";
import { getAppPort } from "../../../../shared/ports";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";

// Import our utility modules

/**
 * Read screenshot entries for a single app directory, filtered by filename
 * pattern and stat'd for mtime. Swallows per-file errors (races with prune).
 */
export async function readScreenshotEntries(
  screenshotDir: string,
): Promise<{ name: string; mtimeMs: number }[]> {
  let entries: string[];
  try {
    entries = await fsPromises.readdir(screenshotDir);
  } catch {
    return [];
  }
  const results: { name: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!SCREENSHOT_FILENAME_REGEX.test(entry)) continue;
    try {
      const stat = await fsPromises.stat(path.join(screenshotDir, entry));
      results.push({ name: entry, mtimeMs: stat.mtimeMs });
    } catch {
      // File disappeared between readdir and stat — skip.
    }
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

export const logger = log.scope("app_handlers");
export const handle = createLoggedHandler(logger);

export function formatCloudSandboxError(error: unknown) {
  if (!(error instanceof CloudSandboxApiError)) {
    return error instanceof Error ? error.message : String(error);
  }

  switch (error.code) {
    case "sandbox_pro_required":
      return "OrianBuilder Pro is required to use cloud sandboxes.";
    case "sandbox_insufficient_credits":
      return "You need at least 1 credit available to start a cloud sandbox.";
    case "sandbox_billing_unavailable":
      return "OrianBuilder couldn’t verify sandbox billing right now. Please try again.";
    case "sandbox_credits_exhausted":
      return "This cloud sandbox stopped because your credits ran out.";
    default:
      if (error.status === 404) {
        return "This cloud sandbox is no longer available.";
      }
      if (error.status === 401 || error.status === 403) {
        return "OrianBuilder couldn’t authorize the cloud sandbox request. Please try again.";
      }
      if (error.status === 429) {
        return "OrianBuilder is rate limiting cloud sandbox requests right now. Please try again.";
      }
      if (typeof error.status === "number" && error.status >= 500) {
        return "OrianBuilder’s cloud sandbox service is temporarily unavailable. Please try again.";
      }
      return error.message;
  }
}

export {
  sanitizeSnippetText,
  byteOffsetToCharIndex,
  buildSnippetFromMatch,
  searchAppFilesWithRipgrep,
} from "./app_search";
export {
  getDefaultCommand,
  getTemplateRuntimeCommands,
  isStaleExpoRuntimeCommand,
  resolveRuntimeCommandsForApp,
  getCommand,
} from "./app_runtime_commands";
export {
  APP_OUTPUT_FLUSH_INTERVAL_MS,
  pendingOutputs,
  flushTimer,
  enqueueAppOutput,
  flushAllAppOutputs,
  listenToProcess,
} from "./app_output_stream";
import { getDefaultCommand } from "./app_runtime_commands";
export async function copyDir(
  source: string,
  destination: string,
  filter?: (source: string) => boolean,
  options?: { excludeNodeModules?: boolean },
) {
  await fsPromises.cp(source, destination, {
    recursive: true,
    filter: (src: string) => {
      if (
        options?.excludeNodeModules &&
        path.basename(src) === "node_modules"
      ) {
        return false;
      }
      if (filter) {
        return filter(src);
      }
      return true;
    },
  });
}

// Needed, otherwise electron in MacOS/Linux will not be able
// to find node/pnpm.
fixPath();

export async function executeApp({
  appPath,
  appId,
  event, // Keep event for local-node case
  isNeon,
  installCommand,
  startCommand,
}: {
  appPath: string;
  appId: number;
  event: Electron.IpcMainInvokeEvent;
  isNeon: boolean;
  installCommand?: string | null;
  startCommand?: string | null;
}): Promise<void> {
  const settings = readSettings();
  const runtimeMode = settings.runtimeMode2 ?? "host";

  if (runtimeMode === "docker") {
    await executeAppInDocker({
      appPath,
      appId,
      event,
      isNeon,
      installCommand,
      startCommand,
    });
  } else if (runtimeMode === "cloud") {
    await executeAppInCloud({
      appPath,
      appId,
      event,
      installCommand,
      startCommand,
    });
  } else {
    await executeAppLocalNode({
      appPath,
      appId,
      event,
      isNeon,
      installCommand,
      startCommand,
    });
  }
}

export function emitProxyServerStarted({
  appId,
  event,
  proxyUrl,
  originalUrl,
  mode,
}: {
  appId: number;
  event: Electron.IpcMainInvokeEvent;
  proxyUrl: string;
  originalUrl: string;
  mode: RuntimeMode2;
}) {
  safeSend(event.sender, "app:output", {
    type: "stdout",
    message: `[orianbuilder-proxy-server]started=[${proxyUrl}] original=[${originalUrl}] mode=[${mode}]`,
    appId,
  });
}

export async function ensureProxyForRunningApp({
  appId,
  event,
  originalUrl,
  mode,
}: {
  appId: number;
  event: Electron.IpcMainInvokeEvent;
  originalUrl: string;
  mode: RuntimeMode2;
}): Promise<void> {
  const appInfo = runningApps.get(appId);
  if (!appInfo) {
    return;
  }

  const proxyAuthToken =
    mode === "cloud" ? appInfo.cloudPreviewAuthToken : undefined;

  if (
    appInfo.proxyWorker &&
    appInfo.originalUrl === originalUrl &&
    appInfo.proxyAuthToken === proxyAuthToken &&
    appInfo.proxyUrl
  ) {
    emitProxyServerStarted({
      appId,
      event,
      proxyUrl: appInfo.proxyUrl,
      originalUrl,
      mode,
    });
    return;
  }

  if (appInfo.proxyWorker) {
    await appInfo.proxyWorker.terminate();
    appInfo.proxyWorker = undefined;
  }

  const proxyWorker = await startProxy(originalUrl, {
    onStarted: (proxyUrl) => {
      const latestAppInfo = runningApps.get(appId);
      if (latestAppInfo) {
        latestAppInfo.proxyUrl = proxyUrl;
        latestAppInfo.originalUrl = originalUrl;
        latestAppInfo.proxyAuthToken = proxyAuthToken;
      }
      emitProxyServerStarted({
        appId,
        event,
        proxyUrl,
        originalUrl,
        mode,
      });
    },
    fixedHeaders:
      mode === "cloud" && proxyAuthToken
        ? {
            Authorization: `Bearer ${proxyAuthToken}`,
          }
        : undefined,
  });

  const latestAppInfo = runningApps.get(appId);
  if (latestAppInfo) {
    latestAppInfo.proxyWorker = proxyWorker;
    latestAppInfo.originalUrl = originalUrl;
    latestAppInfo.proxyAuthToken = proxyAuthToken;
  } else {
    await proxyWorker.terminate();
  }
}

export async function executeAppLocalNode({
  appPath,
  appId,
  event,
  isNeon,
  installCommand,
  startCommand,
}: {
  appPath: string;
  appId: number;
  event: Electron.IpcMainInvokeEvent;
  isNeon: boolean;
  installCommand?: string | null;
  startCommand?: string | null;
}): Promise<void> {
  const command = getCommand({ appId, installCommand, startCommand });
  const appPort = getAppPort(appId);
  const spawnedProcess = spawn(command, [], {
    cwd: appPath,
    shell: true,
    stdio: "pipe", // Ensure stdio is piped so we can capture output/errors and detect close
    detached: false, // Ensure child process is attached to the main process lifecycle unless explicitly backgrounded
    env: {
      ...process.env,
      PORT: String(appPort),
    },
  });

  // Check if process spawned correctly
  if (!spawnedProcess.pid) {
    // Attempt to capture any immediate errors if possible
    let errorOutput = "";
    let spawnErr: any | null = null;
    spawnedProcess.stderr?.on(
      "data",
      (data) => (errorOutput += data.toString()),
    );
    await new Promise<void>((resolve) => {
      spawnedProcess.once("error", (err) => {
        spawnErr = err;
        resolve();
      });
    }); // Wait for error event

    const details = [
      spawnErr?.message ? `message=${spawnErr.message}` : null,
      spawnErr?.code ? `code=${spawnErr.code}` : null,
      spawnErr?.errno ? `errno=${spawnErr.errno}` : null,
      spawnErr?.syscall ? `syscall=${spawnErr.syscall}` : null,
      spawnErr?.path ? `path=${spawnErr.path}` : null,
      spawnErr?.spawnargs
        ? `spawnargs=${JSON.stringify(spawnErr.spawnargs)}`
        : null,
    ]
      .filter(Boolean)
      .join(", ");

    logger.error(
      `Failed to spawn process for app ${appId}. Command="${command}", CWD="${appPath}", ${details}\nSTDERR:\n${
        errorOutput || "(empty)"
      }`,
    );

    throw new Error(
      `Failed to spawn process for app ${appId}.
Error output:
${errorOutput || "(empty)"}
Details: ${details || "n/a"}
`,
    );
  }

  // Increment the counter and store the process reference with its ID
  const currentProcessId = processCounter.increment();
  runningApps.set(appId, {
    process: spawnedProcess,
    processId: currentProcessId,
    mode: "host",
    rendererSender: event.sender,
    lastViewedAt: Date.now(),
  });

  listenToProcess({
    process: spawnedProcess,
    appId,
    isNeon,
    event,
  });
}

export let cloudSandboxSyncUpdateListenerRegistered = false;

export function registerCloudSandboxSyncUpdateListener(): void {
  if (cloudSandboxSyncUpdateListenerRegistered) {
    return;
  }

  setCloudSandboxSyncUpdateListener(({ appId, errorMessage }) => {
    const appInfo = runningApps.get(appId);
    if (!appInfo || appInfo.mode !== "cloud") {
      return;
    }

    const previousErrorMessage = appInfo.cloudSyncErrorMessage ?? null;
    appInfo.cloudSyncErrorMessage = errorMessage ?? undefined;

    const sender = appInfo.rendererSender;
    if (!sender) {
      return;
    }

    if (errorMessage) {
      if (previousErrorMessage === errorMessage) {
        return;
      }

      addLog({
        level: "error",
        type: "server",
        message: errorMessage,
        timestamp: Date.now(),
        appId,
      });

      safeSend(sender, "app:output", {
        type: "sync-error",
        message: errorMessage,
        appId,
      });
      return;
    }

    if (!previousErrorMessage) {
      return;
    }

    const recoveredMessage =
      "Cloud sandbox sync recovered. Local changes are uploading again.";

    addLog({
      level: "info",
      type: "server",
      message: recoveredMessage,
      timestamp: Date.now(),
      appId,
    });

    safeSend(sender, "app:output", {
      type: "sync-recovered",
      message: recoveredMessage,
      appId,
    });
  });

  cloudSandboxSyncUpdateListenerRegistered = true;
}

import { listenToProcess } from "./app_output_stream";
import { resolveRuntimeCommandsForApp } from "./app_runtime_commands";

export async function runAppById(
  event: Electron.IpcMainInvokeEvent,
  appId: number,
): Promise<void> {
  return withLock(appId, async () => {
    // Check if app is already running
    if (runningApps.has(appId)) {
      logger.debug(`App ${appId} is already running.`);
      // Re-emit the proxy URL so the frontend can restore the preview
      const appInfo = runningApps.get(appId);
      if (appInfo?.proxyUrl && appInfo?.originalUrl) {
        emitProxyServerStarted({
          appId,
          event,
          proxyUrl: appInfo.proxyUrl,
          originalUrl: appInfo.originalUrl,
          mode: appInfo.mode,
        });
      }
      return;
    }

    const app = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
    });

    if (!app) {
      throw new OrianBuilderError(
        "App not found",
        OrianBuilderErrorKind.NotFound,
      );
    }

    logger.debug(`Starting app ${appId} in path ${app.path}`);

    const appPath = getOrianBuilderAppPath(app.path);
    const runtimeCommands = await resolveRuntimeCommandsForApp({
      appPath,
      appId,
      installCommand: app.installCommand,
      startCommand: app.startCommand,
    });
    try {
      // There may have been a previous run that left a process on this port.
      await cleanUpPort(getAppPort(appId));
      await executeApp({
        appPath,
        appId,
        event,
        isNeon: !!app.neonProjectId,
        installCommand: runtimeCommands.installCommand,
        startCommand: runtimeCommands.startCommand,
      });

      return;
    } catch (error: any) {
      logger.error(`Error running app ${appId}:`, error);
      // Ensure cleanup if error happens during setup but before process events are handled
      if (
        runningApps.has(appId) &&
        runningApps.get(appId)?.processId === processCounter.value
      ) {
        runningApps.delete(appId);
      }
      throw new OrianBuilderError(
        `Failed to run app ${appId}: ${error.message}`,
        OrianBuilderErrorKind.External,
      );
    }
  });
}

export async function stopAppById(appId: number): Promise<void> {
  logger.log(
    `Attempting to stop app ${appId}. Current running apps: ${runningApps.size}`,
  );
  return withLock(appId, async () => {
    const appInfo = runningApps.get(appId);

    if (!appInfo) {
      logger.log(
        `App ${appId} not found in running apps map. Assuming already stopped.`,
      );
      return;
    }

    const { process, processId } = appInfo;
    logger.log(
      `Found running app ${appId} with processId ${processId}${process?.pid ? ` (PID: ${process.pid})` : ""}. Attempting to stop.`,
    );

    // Check if the process is already exited or closed
    if (process && (process.exitCode !== null || process.signalCode !== null)) {
      logger.log(
        `Process for app ${appId} (PID: ${process.pid}) already exited (code: ${process.exitCode}, signal: ${process.signalCode}). Cleaning up map.`,
      );
      runningApps.delete(appId); // Ensure cleanup if somehow missed
      return;
    }

    try {
      await stopAppByInfo(appId, appInfo);

      // Now, safely remove the app from the map *after* confirming closure
      if (process) {
        removeAppIfCurrentProcess(appId, process);
      }

      return;
    } catch (error: any) {
      logger.error(
        `Error stopping app ${appId}${process?.pid ? ` (PID: ${process.pid}, processId: ${processId})` : ` (processId: ${processId})`}:`,
        error,
      );
      // Attempt cleanup even if an error occurred during the stop process
      if (process) {
        removeAppIfCurrentProcess(appId, process);
      } else if (appInfo.mode !== "cloud") {
        runningApps.delete(appId);
      }
      throw new OrianBuilderError(
        `Failed to stop app ${appId}: ${error.message}`,
        OrianBuilderErrorKind.External,
      );
    }
  });
}

export async function executeAppInDocker({
  appPath,
  appId,
  event,
  isNeon,
  installCommand,
  startCommand,
}: {
  appPath: string;
  appId: number;
  event: Electron.IpcMainInvokeEvent;
  isNeon: boolean;
  installCommand?: string | null;
  startCommand?: string | null;
}): Promise<void> {
  const containerName = `orianbuilder-app-${appId}`;

  // First, check if Docker is available
  try {
    await new Promise<void>((resolve, reject) => {
      const checkDocker = spawn("docker", ["--version"], { stdio: "pipe" });
      checkDocker.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error("Docker is not available"));
        }
      });
      checkDocker.on("error", () => {
        reject(new Error("Docker is not available"));
      });
    });
  } catch {
    throw new Error(
      "Docker is required but not available. Please install Docker Desktop and ensure it's running.",
    );
  }

  // Stop and remove any existing container with the same name
  try {
    await new Promise<void>((resolve) => {
      const stopContainer = spawn("docker", ["stop", containerName], {
        stdio: "pipe",
      });
      stopContainer.on("close", () => {
        const removeContainer = spawn("docker", ["rm", containerName], {
          stdio: "pipe",
        });
        removeContainer.on("close", () => resolve());
        removeContainer.on("error", () => resolve()); // Container might not exist
      });
      stopContainer.on("error", () => resolve()); // Container might not exist
    });
  } catch (error) {
    logger.info(
      `Docker container ${containerName} not found. Ignoring error: ${error}`,
    );
  }

  // Create a Dockerfile in the app directory if it doesn't exist
  const dockerfilePath = path.join(appPath, "Dockerfile.orianbuilder");
  if (!fs.existsSync(dockerfilePath)) {
    const dockerfileContent = `FROM node:22-alpine

# Install pnpm
RUN npm install -g pnpm
`;

    try {
      await fsPromises.writeFile(dockerfilePath, dockerfileContent, "utf-8");
    } catch (error) {
      logger.error(`Failed to create Dockerfile for app ${appId}:`, error);
      throw new OrianBuilderError(
        `Failed to create Dockerfile: ${error}`,
        OrianBuilderErrorKind.External,
      );
    }
  }

  // Build the Docker image
  const buildProcess = spawn(
    "docker",
    [
      "build",
      "-f",
      "Dockerfile.orianbuilder",
      "-t",
      `orianbuilder-app-${appId}`,
      ".",
    ],
    {
      cwd: appPath,
      stdio: "pipe",
    },
  );

  let buildError = "";
  buildProcess.stderr?.on("data", (data) => {
    buildError += data.toString();
  });

  await new Promise<void>((resolve, reject) => {
    buildProcess.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Docker build failed: ${buildError}`));
      }
    });
    buildProcess.on("error", (err) => {
      reject(new Error(`Docker build process error: ${err.message}`));
    });
  });

  // Run the Docker container
  const port = getAppPort(appId);
  const process = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      containerName,
      "-p",
      `${port}:${port}`,
      "-v",
      `${appPath}:/app`,
      "-v",
      `orianbuilder-pnpm-${appId}:/app/.pnpm-store`,
      "-e",
      "PNPM_STORE_PATH=/app/.pnpm-store",
      "-w",
      "/app",
      `orianbuilder-app-${appId}`,
      "sh",
      "-c",
      getCommand({ appId, installCommand, startCommand }),
    ],
    {
      stdio: "pipe",
      detached: false,
    },
  );

  // Check if process spawned correctly
  if (!process.pid) {
    // Attempt to capture any immediate errors if possible
    let errorOutput = "";
    let spawnErr: any = null;
    process.stderr?.on("data", (data) => (errorOutput += data.toString()));
    await new Promise<void>((resolve) => {
      process.once("error", (err) => {
        spawnErr = err;
        resolve();
      });
    }); // Wait for error event

    const details = [
      spawnErr?.message ? `message=${spawnErr.message}` : null,
      spawnErr?.code ? `code=${spawnErr.code}` : null,
      spawnErr?.errno ? `errno=${spawnErr.errno}` : null,
      spawnErr?.syscall ? `syscall=${spawnErr.syscall}` : null,
      spawnErr?.path ? `path=${spawnErr.path}` : null,
      spawnErr?.spawnargs
        ? `spawnargs=${JSON.stringify(spawnErr.spawnargs)}`
        : null,
    ]
      .filter(Boolean)
      .join(", ");

    logger.error(
      `Failed to spawn Docker container for app ${appId}. ${details}\nSTDERR:\n${
        errorOutput || "(empty)"
      }`,
    );

    throw new Error(
      `Failed to spawn Docker container for app ${appId}.
Details: ${details || "n/a"}
STDERR:
${errorOutput || "(empty)"}`,
    );
  }

  // Increment the counter and store the process reference with its ID
  const currentProcessId = processCounter.increment();
  runningApps.set(appId, {
    process,
    processId: currentProcessId,
    mode: "docker",
    rendererSender: event.sender,
    containerName,
    lastViewedAt: Date.now(),
  });

  listenToProcess({
    process,
    appId,
    isNeon,
    event,
  });
}

export async function executeAppInCloud({
  appPath,
  appId,
  event,
  installCommand,
  startCommand,
}: {
  appPath: string;
  appId: number;
  event: Electron.IpcMainInvokeEvent;
  installCommand?: string | null;
  startCommand?: string | null;
}): Promise<void> {
  const currentProcessId = processCounter.increment();
  let sandboxId: string | undefined;
  let previewUrl: string | undefined;
  let previewAuthToken: string | undefined;

  try {
    const createResult = await createCloudSandbox({
      appId,
      appPath,
      installCommand,
      startCommand,
    });
    sandboxId = createResult.sandboxId;
    previewUrl = createResult.previewUrl;
    previewAuthToken = createResult.previewAuthToken;

    const files = await buildCloudSandboxFileMap(appPath);
    const uploadResult = await uploadCloudSandboxFiles({
      sandboxId,
      files,
      replaceAll: true,
    });
    previewUrl = uploadResult.previewUrl ?? previewUrl;
    previewAuthToken = uploadResult.previewAuthToken ?? previewAuthToken;
  } catch (error) {
    if (sandboxId) {
      try {
        await destroyCloudSandbox(sandboxId);
      } catch (cleanupError) {
        logger.warn(
          `Failed to clean up cloud sandbox ${sandboxId} after startup error for app ${appId}:`,
          cleanupError,
        );
      }
    }
    throw new Error(formatCloudSandboxError(error));
  }

  const resolvedPreviewUrl = previewUrl;
  const resolvedPreviewAuthToken = previewAuthToken;
  if (!sandboxId || !resolvedPreviewUrl || !resolvedPreviewAuthToken) {
    throw new Error(
      "Cloud sandbox startup returned incomplete preview credentials.",
    );
  }

  const cloudLogAbortController = new AbortController();
  runningApps.set(appId, {
    process: null,
    processId: currentProcessId,
    mode: "cloud",
    rendererSender: event.sender,
    cloudSandboxId: sandboxId,
    cloudPreviewUrl: resolvedPreviewUrl,
    cloudPreviewAuthToken: resolvedPreviewAuthToken,
    cloudLogAbortController,
    lastViewedAt: Date.now(),
    originalUrl: resolvedPreviewUrl,
  });
  registerRunningCloudSandbox({
    appId,
    appPath,
    sandboxId,
  });

  await ensureProxyForRunningApp({
    appId,
    event,
    originalUrl: resolvedPreviewUrl,
    mode: "cloud",
  });

  startCloudSandboxLogStream({
    appId,
    event,
    sandboxId,
    cloudLogAbortController,
  });
}

export function startCloudSandboxLogStream(input: {
  appId: number;
  event: Electron.IpcMainInvokeEvent;
  sandboxId: string;
  cloudLogAbortController: AbortController;
}) {
  void (async () => {
    try {
      for await (const message of streamCloudSandboxLogs(
        input.sandboxId,
        input.cloudLogAbortController.signal,
      )) {
        const appInfo = runningApps.get(input.appId);
        if (!appInfo || appInfo.cloudSandboxId !== input.sandboxId) {
          return;
        }

        addLog({
          level: "info",
          type: "server",
          message,
          timestamp: Date.now(),
          appId: input.appId,
        });

        safeSend(input.event.sender, "app:output", {
          type: "stdout",
          message,
          appId: input.appId,
        });
      }
    } catch (error) {
      if (input.cloudLogAbortController.signal.aborted) {
        return;
      }

      const message =
        error instanceof Error
          ? error.message
          : `Cloud sandbox log stream failed: ${String(error)}`;

      addLog({
        level: "error",
        type: "server",
        message,
        timestamp: Date.now(),
        appId: input.appId,
      });

      safeSend(input.event.sender, "app:output", {
        type: "stderr",
        message,
        appId: input.appId,
      });
    }
  })();
}

// Helper to kill process on a specific port (cross-platform, using kill-port)
export async function killProcessOnPort(port: number): Promise<void> {
  try {
    await killPort(port, "tcp");
  } catch {
    // Ignore if nothing was running on that port
  }
}

// Helper to stop any Docker containers publishing a given host port
export async function stopDockerContainersOnPort(port: number): Promise<void> {
  try {
    // List container IDs that publish the given port
    const list = spawn("docker", ["ps", "--filter", `publish=${port}`, "-q"], {
      stdio: "pipe",
    });

    let stdout = "";
    list.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    await new Promise<void>((resolve) => {
      list.on("close", () => resolve());
      list.on("error", () => resolve());
    });

    const containerIds = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (containerIds.length === 0) {
      return;
    }

    // Stop each container best-effort
    await Promise.all(
      containerIds.map(
        (id) =>
          new Promise<void>((resolve) => {
            const stop = spawn("docker", ["stop", id], { stdio: "pipe" });
            stop.on("close", () => resolve());
            stop.on("error", () => resolve());
          }),
      ),
    );
  } catch (e) {
    logger.warn(`Failed stopping Docker containers on port ${port}: ${e}`);
  }
}

import { getCommand } from "./app_runtime_commands";

export async function cleanUpPort(port: number) {
  const settings = readSettings();
  if (settings.runtimeMode2 === "docker") {
    await stopDockerContainersOnPort(port);
  } else {
    await killProcessOnPort(port);
  }
}
