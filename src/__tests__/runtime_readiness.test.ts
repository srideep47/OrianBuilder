import { afterEach, describe, expect, it } from "vitest";

import { addLog, clearLogs } from "@/lib/log_store";
import {
  getManagedRuntimeStatus,
  waitForManagedRuntimeReady,
} from "@/ipc/utils/runtime_readiness";
import { runningApps } from "@/ipc/utils/process_manager";

describe("runtime readiness utilities", () => {
  afterEach(() => {
    runningApps.clear();
    clearLogs(42);
  });

  it("reports stopped status with recent errors", () => {
    addLog({
      appId: 42,
      level: "error",
      type: "server",
      message: "startup failed",
      timestamp: Date.now(),
    });

    expect(getManagedRuntimeStatus(42)).toMatchObject({
      appId: 42,
      status: "failed",
      mode: null,
      lastError: "startup failed",
    });
  });

  it("polls the preview URL until it is ready", async () => {
    runningApps.set(42, {
      process: null,
      processId: 9,
      mode: "host",
      lastViewedAt: Date.now(),
      proxyUrl: "http://localhost:3999",
      originalUrl: "http://localhost:3000",
    });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("ECONNREFUSED");
      }
      return { ok: true, status: 200 } as Response;
    };

    await expect(
      waitForManagedRuntimeReady({
        appId: 42,
        timeoutMs: 1_000,
        intervalMs: 1,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toMatchObject({
      ready: true,
      previewUrl: "http://localhost:3999",
      statusCode: 200,
      error: null,
    });
  });
});
