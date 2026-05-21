/**
 * IPC surface for the Watchdog page.
 *
 * - `runSetup` orchestrates Python detection → venv → pip install. Progress is
 *    broadcast on `watchdog:setup-progress` so the page can show a live log.
 * - `start` / `stop` manage the FastAPI child process.
 * - `getStatus` / `getApiBaseUrl` give the renderer the connection details
 *    it needs for the REST CRUD calls (websites, products, history).
 * - `uninstall` removes the venv + marker (preserves the database).
 *
 * The REST surface itself (/websites, /products, …) is exposed by the FastAPI
 * backend on http://127.0.0.1:8765 and the renderer talks to it directly via
 * fetch — there is no IPC proxy for those CRUD calls. CORS in the backend is
 * permissive, and the port is loopback-bound so it never leaves the host.
 */
import { BrowserWindow } from "electron";

import { createTypedHandler } from "./base";
import { watchdogContracts, watchdogEvents } from "@/ipc/types/watchdog";
import {
  runFullSetup,
  uninstall as uninstallVenv,
  isSetupComplete,
} from "@/main/watchdog/venv_installer";
import {
  watchdogBackend,
  WATCHDOG_DEFAULT_HOST,
  WATCHDOG_DEFAULT_PORT,
} from "@/main/watchdog/backend_process";
import { EMBEDDED_BASE_URL } from "@/ipc/utils/embedded_inference_server";

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function emitStatusChanged(): void {
  broadcast(watchdogEvents.statusChanged.channel, watchdogBackend.getStatus());
}

let activeSetup: Promise<unknown> | null = null;

export function registerWatchdogHandlers(): void {
  createTypedHandler(watchdogContracts.getStatus, async () => {
    return watchdogBackend.getStatus();
  });

  createTypedHandler(watchdogContracts.getApiBaseUrl, async () => {
    const status = watchdogBackend.getStatus();
    if (status.running && status.host && status.port) {
      return { baseUrl: `http://${status.host}:${status.port}` };
    }
    // Before the backend is up there's no real base URL to report. The page
    // uses this to decide whether to render the dashboard or the setup card.
    return { baseUrl: null };
  });

  createTypedHandler(watchdogContracts.runSetup, async (_event, params) => {
    if (activeSetup) {
      return {
        ok: false,
        message:
          "Setup is already in progress — wait for it to finish before retrying.",
      };
    }
    const promise = runFullSetup({
      pythonOverride: params.pythonOverride ?? null,
      force: params.force ?? false,
      onEvent: (evt) =>
        broadcast(watchdogEvents.setupProgress.channel, {
          phase: evt.phase,
          line: evt.line,
          message: evt.message,
          python: evt.python,
        }),
    });
    activeSetup = promise;
    try {
      const result = await promise;
      emitStatusChanged();
      return result.ok
        ? { ok: true, message: "Setup complete" }
        : { ok: false, message: result.message };
    } finally {
      activeSetup = null;
    }
  });

  createTypedHandler(watchdogContracts.start, async () => {
    if (!isSetupComplete()) {
      return {
        ok: false,
        message: "Watchdog is not set up yet. Run setup first.",
        status: watchdogBackend.getStatus(),
      };
    }
    try {
      await watchdogBackend.start({
        host: WATCHDOG_DEFAULT_HOST,
        port: WATCHDOG_DEFAULT_PORT,
        // Route LLM summaries through OrianBuilder's embedded llama-server.
        // If no model is loaded the summarize call returns a fallback string
        // and the rest of the app still works.
        llmBaseUrl: EMBEDDED_BASE_URL,
        llmModel: "embedded",
      });
      emitStatusChanged();
      return {
        ok: true,
        message: "Backend started",
        status: watchdogBackend.getStatus(),
      };
    } catch (err) {
      emitStatusChanged();
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        status: watchdogBackend.getStatus(),
      };
    }
  });

  createTypedHandler(watchdogContracts.stop, async () => {
    await watchdogBackend.stop();
    emitStatusChanged();
    return { ok: true };
  });

  createTypedHandler(watchdogContracts.uninstall, async () => {
    // Stop the backend before yanking the venv out from under it.
    await watchdogBackend.stop();
    uninstallVenv();
    emitStatusChanged();
    return { ok: true };
  });
}
