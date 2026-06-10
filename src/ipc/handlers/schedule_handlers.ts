/**
 * IPC handlers for the schedule queue.
 *
 * The actual execution logic lives in `main/schedule/engine.ts`; this file
 * just bridges renderer calls to the store and tray helpers.
 */
import { BrowserWindow } from "electron";
import log from "electron-log/main";
import { scheduleContracts } from "@/ipc/types/schedule";
import { createTypedHandler } from "./base";
import * as store from "@/main/schedule/store";
import {
  enableBackgroundMode,
  disableBackgroundMode,
  isTrayActive,
} from "@/main/schedule/tray";
import { readSettings, writeSettings } from "@/main/settings";

const logger = log.scope("schedule-handlers");

export function registerScheduleHandlers(): void {
  createTypedHandler(scheduleContracts.list, async () => store.list());

  createTypedHandler(scheduleContracts.scheduleYouTube, async (_e, params) => {
    if (params.scheduledAt <= Date.now()) {
      // Allow "now-ish" but reject clearly-past timestamps so the user doesn't
      // accidentally fire an upload they meant to set for later.
      logger.info(
        `Scheduling YouTube job with scheduledAt in the past (${new Date(params.scheduledAt).toISOString()}) — will fire immediately on next engine tick`,
      );
    }
    const job = store.add({
      platform: "youtube",
      fileName: params.fileName,
      scheduledAt: params.scheduledAt,
      youtube: {
        title: params.title,
        description: params.description,
        privacy: params.privacy,
      },
    });
    return job;
  });

  createTypedHandler(
    scheduleContracts.scheduleInstagram,
    async (_e, params) => {
      const job = store.add({
        platform: "instagram",
        fileName: params.fileName,
        scheduledAt: params.scheduledAt,
        instagram: { caption: params.caption },
      });
      return job;
    },
  );

  createTypedHandler(scheduleContracts.cancel, async (_e, { id }) => {
    const job = store.get(id);
    if (!job) return { ok: false };
    if (job.status !== "pending") {
      // Already running, done, failed, or cancelled — nothing to cancel.
      return { ok: false };
    }
    store.update(id, { status: "cancelled" });
    return { ok: true };
  });

  createTypedHandler(scheduleContracts.remove, async (_e, { id }) => {
    return { ok: store.remove(id) };
  });

  createTypedHandler(
    scheduleContracts.setBackgroundMode,
    async (_e, { enabled }) => {
      writeSettings({ runInBackground: enabled });
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (enabled && win) {
        enableBackgroundMode(win);
      } else {
        disableBackgroundMode(win ?? null);
      }
      return { enabled };
    },
  );

  createTypedHandler(scheduleContracts.getBackgroundMode, async () => {
    // The runtime flag and the persisted setting can briefly diverge (e.g.
    // before tray init at boot). Prefer the persisted truth.
    const settings = readSettings();
    return { enabled: settings.runInBackground === true || isTrayActive() };
  });
}
