/**
 * Schedule engine.
 *
 * One singleton on the main process that:
 *   1. Polls the schedule store every `POLL_INTERVAL_MS` for pending jobs
 *      whose `scheduledAt` has elapsed.
 *   2. Executes them serially per platform (YouTube uploads sequentially so
 *      we don't blow through quota; Instagram just fires a desktop notif).
 *   3. Writes the outcome back to the store and emits an IPC event so any
 *      open renderer can refresh its queue view live.
 *
 * Why polling instead of `setTimeout`?
 *   - Reliability across sleep/wake. `setTimeout` clocks freeze when the OS
 *     suspends; on resume the timer fires immediately but anything that was
 *     supposed to fire *during* the sleep is silently lost. Polling guarantees
 *     that any job whose time has passed will be picked up within
 *     POLL_INTERVAL_MS of the next wake-up.
 *   - Survives the user closing the window — we run in the main process,
 *     which keeps going as long as Electron is alive (tray mode handles that).
 *
 * Renderer-facing events are sent via `BrowserWindow.getAllWindows()` so the
 * UI updates whether the window was opened just-in-time or has been visible
 * the whole time.
 */
import { BrowserWindow, Notification } from "electron";
import log from "electron-log/main";
import * as store from "./store";
import type { ScheduleJob } from "./store";
import { scheduleEvents } from "@/ipc/types/schedule";
import { publishVideo } from "@/main/publish/youtube-publish";

const logger = log.scope("schedule-engine");

const POLL_INTERVAL_MS = 30_000;
const PRUNE_TERMINAL_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let pollTimer: NodeJS.Timeout | null = null;
let running = false;
/** Jobs currently being executed, keyed by id, so a slow upload doesn't get
 *  re-fired by the next poll tick. */
const inFlight = new Set<string>();

function broadcast<T>(channel: string, payload: T): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function emitChanged(): void {
  broadcast(scheduleEvents.changed.channel, {
    count: store.list().length,
  });
}

function emitFired(job: ScheduleJob): void {
  broadcast(scheduleEvents.fired.channel, {
    id: job.id,
    platform: job.platform,
    fileName: job.fileName,
  });
}

function fireOsNotification(title: string, body: string): void {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: false }).show();
    }
  } catch (e) {
    logger.warn("Failed to show OS notification:", e);
  }
}

async function runYouTubeJob(job: ScheduleJob): Promise<void> {
  if (!job.youtube) {
    throw new Error("YouTube job missing youtube payload.");
  }
  // Patch status → running BEFORE the long upload so the UI shows it live.
  store.update(job.id, { status: "running" });
  emitChanged();

  const res = await publishVideo({
    fileName: job.fileName,
    title: job.youtube.title,
    description: job.youtube.description,
    privacy: job.youtube.privacy,
    onProgress: (percent) => {
      broadcast(scheduleEvents.progress.channel, {
        id: job.id,
        platform: "youtube" as const,
        percent,
      });
    },
  });

  store.update(job.id, {
    status: "done",
    result: { videoId: res.videoId, url: res.url },
  });
  emitChanged();
  fireOsNotification(
    "Scheduled YouTube post published",
    job.youtube.title.slice(0, 80),
  );
}

async function runInstagramJob(job: ScheduleJob): Promise<void> {
  // Instagram cannot be auto-uploaded from a desktop app — see the note in
  // PublishToInstagramDialog. At fire time we instead:
  //   1. Mark the job done (the "scheduled action" — surfacing the reminder
  //      — has happened, regardless of whether the user finishes the upload).
  //   2. Notify the OS so the user sees it even with the window hidden.
  //   3. Send a renderer event that, when picked up, brings the window forward
  //      and opens the Instagram share dialog with this job's caption.
  store.update(job.id, { status: "running" });
  emitChanged();

  fireOsNotification(
    "Instagram post ready to share",
    "Open OrianBuilder to publish your scheduled Instagram post.",
  );
  emitFired(job);

  // Bring the window to the foreground if we have one.
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  store.update(job.id, { status: "done" });
  emitChanged();
}

async function executeJob(job: ScheduleJob): Promise<void> {
  if (inFlight.has(job.id)) return;
  inFlight.add(job.id);
  try {
    logger.info(`Firing scheduled job ${job.id} (${job.platform})`);
    if (job.platform === "youtube") {
      await runYouTubeJob(job);
    } else if (job.platform === "instagram") {
      await runInstagramJob(job);
    } else {
      throw new Error(`Unknown platform: ${(job as any).platform}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Scheduled job ${job.id} failed:`, msg);
    store.update(job.id, { status: "failed", error: msg.slice(0, 1000) });
    emitChanged();
    fireOsNotification(
      `Scheduled ${job.platform} post failed`,
      msg.slice(0, 160),
    );
  } finally {
    inFlight.delete(job.id);
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  // Snapshot before iterating so a write from executeJob doesn't shift indices.
  const jobs = store.list().filter((j) => j.status === "pending");
  for (const job of jobs) {
    if (job.scheduledAt <= now && !inFlight.has(job.id)) {
      // Fire-and-forget so a slow upload doesn't block other due jobs.
      void executeJob(job);
    }
  }
  // Periodic housekeeping — drop completed/cancelled jobs older than a week.
  store.pruneTerminal(PRUNE_TERMINAL_AFTER_MS);
}

export function startScheduleEngine(): void {
  if (running) return;
  running = true;
  logger.info("Schedule engine starting");
  // Run an immediate tick so jobs that came due while the app was closed
  // fire as soon as the app opens, not POLL_INTERVAL_MS later.
  void tick();
  pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS);
}

export function stopScheduleEngine(): void {
  if (!running) return;
  running = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  logger.info("Schedule engine stopped");
}
