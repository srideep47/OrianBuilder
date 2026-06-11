/**
 * Persistent store for scheduled publish jobs.
 *
 * A small JSON file under `userData/scheduled-posts.json` that survives app
 * restarts. The schedule engine (engine.ts) reads from here on boot, polls
 * for due jobs while running, and writes status updates back here.
 *
 * Design notes:
 *  - We intentionally keep the on-disk format flat / human-readable so a
 *    user can sanity-check it. No DB dependency for a queue this small.
 *  - File I/O is synchronous: the queue is tiny (typical user has < 50 jobs)
 *    and write contention is non-existent (only the main process touches it).
 *  - We do NOT persist sensitive fields beyond what the publish call already
 *    needs (title, description, caption). OAuth tokens live in their own
 *    secure stores (e.g. youtube-store.ts).
 */
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import log from "electron-log/main";

const logger = log.scope("schedule-store");

export type SchedulePlatform = "youtube" | "instagram";

export type ScheduleStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export interface ScheduleJob {
  id: string;
  platform: SchedulePlatform;
  fileName: string;
  /** Epoch ms when the job should fire. */
  scheduledAt: number;
  /** Epoch ms when the job was created. */
  createdAt: number;
  status: ScheduleStatus;
  /** Last update epoch ms — used to surface stale "running" jobs. */
  updatedAt: number;

  // ---- Platform-specific payloads ----

  /** YouTube: title, description, privacy. */
  youtube?: {
    title: string;
    description?: string;
    privacy: "public" | "unlisted" | "private";
  };
  /** Instagram: caption only. */
  instagram?: {
    caption: string;
  };

  // ---- Outcome ----

  /** Filled when status === "done". */
  result?: {
    url?: string;
    videoId?: string;
  };
  /** Filled when status === "failed". */
  error?: string;
}

interface StoreFileV1 {
  version: 1;
  jobs: ScheduleJob[];
}

function getStorePath(): string {
  return path.join(app.getPath("userData"), "scheduled-posts.json");
}

function readAll(): ScheduleJob[] {
  const p = getStorePath();
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoreFileV1>;
    if (!parsed || !Array.isArray(parsed.jobs)) return [];
    return parsed.jobs;
  } catch (err) {
    logger.warn("Failed to read schedule store, starting empty:", err);
    return [];
  }
}

function writeAll(jobs: ScheduleJob[]): void {
  const p = getStorePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const data: StoreFileV1 = { version: 1, jobs };
  // Write to a tmp path first, then rename — avoids leaving a half-written
  // file if the process is killed mid-write.
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}

export function list(): ScheduleJob[] {
  // Sorted soonest-first; cancelled / done sink to the bottom by updatedAt desc
  // so the active queue is always visible at the top of the list.
  const jobs = readAll();
  return jobs.slice().sort((a, b) => {
    const aActive = a.status === "pending" || a.status === "running";
    const bActive = b.status === "pending" || b.status === "running";
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    if (aActive && bActive) return a.scheduledAt - b.scheduledAt;
    return b.updatedAt - a.updatedAt;
  });
}

export function get(id: string): ScheduleJob | null {
  return readAll().find((j) => j.id === id) ?? null;
}

export function add(
  job: Omit<ScheduleJob, "id" | "createdAt" | "updatedAt" | "status">,
): ScheduleJob {
  const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const full: ScheduleJob = {
    ...job,
    id,
    createdAt: now,
    updatedAt: now,
    status: "pending",
  };
  const jobs = readAll();
  jobs.push(full);
  writeAll(jobs);
  return full;
}

export function update(
  id: string,
  patch: Partial<ScheduleJob>,
): ScheduleJob | null {
  const jobs = readAll();
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) return null;
  const next: ScheduleJob = {
    ...jobs[i],
    ...patch,
    id: jobs[i].id, // never let the id be overwritten
    updatedAt: Date.now(),
  };
  jobs[i] = next;
  writeAll(jobs);
  return next;
}

export function remove(id: string): boolean {
  const jobs = readAll();
  const next = jobs.filter((j) => j.id !== id);
  if (next.length === jobs.length) return false;
  writeAll(next);
  return true;
}

/** Drop everything in a terminal state older than `maxAgeMs`. */
export function pruneTerminal(maxAgeMs: number): number {
  const now = Date.now();
  const jobs = readAll();
  const next = jobs.filter((j) => {
    if (j.status === "pending" || j.status === "running") return true;
    return now - j.updatedAt < maxAgeMs;
  });
  if (next.length !== jobs.length) {
    writeAll(next);
    return jobs.length - next.length;
  }
  return 0;
}
