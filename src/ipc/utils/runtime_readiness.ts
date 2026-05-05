import { getAppPort } from "../../../shared/ports";
import { getLogs } from "@/lib/log_store";
import { runningApps } from "./process_manager";

export type ManagedRuntimeStatus = {
  appId: number;
  status: "stopped" | "starting" | "running" | "failed";
  mode: "host" | "docker" | "cloud" | null;
  processId: number | null;
  pid: number | null;
  previewUrl: string | null;
  originalUrl: string | null;
  recentOutput: string[];
  lastError: string | null;
};

export type RuntimeReadinessResult = ManagedRuntimeStatus & {
  ready: boolean;
  statusCode: number | null;
  error: string | null;
};

export function getManagedRuntimeStatus(appId: number): ManagedRuntimeStatus {
  const appInfo = runningApps.get(appId);
  const recentLogs = getLogs(appId).slice(-30);
  const recentOutput = recentLogs.map((entry) => entry.message);
  const lastError =
    [...recentLogs].reverse().find((entry) => entry.level === "error")
      ?.message ?? null;

  if (!appInfo) {
    return {
      appId,
      status: lastError ? "failed" : "stopped",
      mode: null,
      processId: null,
      pid: null,
      previewUrl: null,
      originalUrl: null,
      recentOutput,
      lastError,
    };
  }

  const previewUrl = getManagedRuntimePreviewUrl(appId);
  const processExited =
    appInfo.process &&
    (appInfo.process.exitCode !== null || appInfo.process.signalCode !== null);

  return {
    appId,
    status: processExited ? "failed" : previewUrl ? "running" : "starting",
    mode: appInfo.mode,
    processId: appInfo.processId,
    pid: appInfo.process?.pid ?? null,
    previewUrl,
    originalUrl: appInfo.originalUrl ?? null,
    recentOutput,
    lastError,
  };
}

export function getManagedRuntimePreviewUrl(appId: number): string {
  const appInfo = runningApps.get(appId);
  return (
    appInfo?.proxyUrl ??
    appInfo?.originalUrl ??
    appInfo?.cloudPreviewUrl ??
    `http://localhost:${getAppPort(appId)}`
  );
}

export async function waitForManagedRuntimeReady(input: {
  appId: number;
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<RuntimeReadinessResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const intervalMs = input.intervalMs ?? 500;
  const fetchImpl = input.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  let lastError: string | null = null;
  let lastStatusCode: number | null = null;

  while (Date.now() <= deadline) {
    const status = getManagedRuntimeStatus(input.appId);
    const previewUrl =
      status.previewUrl ?? getManagedRuntimePreviewUrl(input.appId);

    try {
      const response = await fetchImpl(previewUrl, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(intervalMs, 2_000)),
      });
      lastStatusCode = response.status;
      if (response.ok || (response.status >= 300 && response.status < 500)) {
        return {
          ...getManagedRuntimeStatus(input.appId),
          previewUrl,
          ready: true,
          statusCode: response.status,
          error: null,
        };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return {
    ...getManagedRuntimeStatus(input.appId),
    previewUrl: getManagedRuntimePreviewUrl(input.appId),
    ready: false,
    statusCode: lastStatusCode,
    error: lastError ?? `Timed out after ${timeoutMs}ms`,
  };
}
