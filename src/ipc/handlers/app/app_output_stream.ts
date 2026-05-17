/**
 * Output streaming for running app processes.
 *
 * App stdout/stderr is high-frequency, so we batch outputs per renderer and
 * flush them every APP_OUTPUT_FLUSH_INTERVAL_MS to keep IPC traffic reasonable.
 * Interactive input prompts bypass the batch — they need to reach the UI
 * immediately so the user can respond.
 */

import { ChildProcess } from "node:child_process";
import util from "util";
import log from "electron-log";

import { addLog } from "../../../lib/log_store";
import { safeSend } from "../../utils/safe_sender";
import { removeAppIfCurrentProcess } from "../../utils/process_manager";
import type { AppOutput } from "../../types/misc";
import { ensureProxyForRunningApp } from "./app_shared";

const logger = log.scope("app_handlers");

export const APP_OUTPUT_FLUSH_INTERVAL_MS = 100;

export const pendingOutputs = new Map<Electron.WebContents, AppOutput[]>();
export let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function enqueueAppOutput(
  sender: Electron.WebContents,
  output: AppOutput,
): void {
  let queue = pendingOutputs.get(sender);
  if (!queue) {
    queue = [];
    pendingOutputs.set(sender, queue);
  }
  queue.push(output);

  if (!flushTimer) {
    flushTimer = setTimeout(flushAllAppOutputs, APP_OUTPUT_FLUSH_INTERVAL_MS);
  }
}

export function flushAllAppOutputs(): void {
  flushTimer = null;
  for (const [sender, outputs] of pendingOutputs) {
    if (outputs.length > 0) {
      safeSend(sender, "app:output-batch", outputs);
    }
  }
  pendingOutputs.clear();
}

export function listenToProcess({
  process: spawnedProcess,
  appId,
  isNeon,
  event,
}: {
  process: ChildProcess;
  appId: number;
  isNeon: boolean;
  event: Electron.IpcMainInvokeEvent;
}): void {
  spawnedProcess.stdout?.on("data", async (data) => {
    const message = util.stripVTControlCharacters(data.toString());
    logger.debug(
      `App ${appId} (PID: ${spawnedProcess.pid}) stdout: ${message}`,
    );

    addLog({
      level: "info",
      type: "server",
      message,
      timestamp: Date.now(),
      appId,
    });

    // Auto-answer drizzle's interactive "created or renamed from another"
    // prompt by writing a CR. Gated on isNeon because (1) only Neon apps
    // (the official templates) trigger this path and (2) Neon DBs have
    // point-in-time restore, so an accidental wrong selection is recoverable.
    if (isNeon && message.includes("created or renamed from another")) {
      spawnedProcess.stdin?.write(`\r\n`);
      logger.info(
        `App ${appId} (PID: ${spawnedProcess.pid}) wrote enter to stdin to automatically respond to drizzle push input`,
      );
    }

    const inputRequestPattern = /\s*›\s*\([yY]\/[nN]\)\s*$/;
    const isInputRequest = inputRequestPattern.test(message);
    if (isInputRequest) {
      // Input prompts bypass the batch — UX requires immediate delivery.
      safeSend(event.sender, "app:output", {
        type: "input-requested",
        message,
        appId,
      });
    } else {
      enqueueAppOutput(event.sender, {
        type: "stdout",
        message,
        appId,
      });

      const urlMatch = message.match(/(https?:\/\/localhost:\d+\/?)/);
      if (urlMatch) {
        const originalUrl = urlMatch[1];
        await ensureProxyForRunningApp({
          appId,
          event,
          originalUrl,
          mode: "host",
        });
      }
    }
  });

  spawnedProcess.stderr?.on("data", async (data) => {
    const message = util.stripVTControlCharacters(data.toString());
    logger.error(
      `App ${appId} (PID: ${spawnedProcess.pid}) stderr: ${message}`,
    );

    addLog({
      level: "error",
      type: "server",
      message,
      timestamp: Date.now(),
      appId,
    });

    enqueueAppOutput(event.sender, {
      type: "stderr",
      message,
      appId,
    });
  });

  spawnedProcess.on("close", (code, signal) => {
    logger.log(
      `App ${appId} (PID: ${spawnedProcess.pid}) process closed with code ${code}, signal ${signal}.`,
    );
    flushAllAppOutputs();
    removeAppIfCurrentProcess(appId, spawnedProcess);
  });

  // Errors here are asynchronous — the caller has already received a
  // success response, so we just clean up state.
  spawnedProcess.on("error", (err) => {
    logger.error(
      `Error in app ${appId} (PID: ${spawnedProcess.pid}) process: ${err.message}`,
    );
    removeAppIfCurrentProcess(appId, spawnedProcess);
  });
}
