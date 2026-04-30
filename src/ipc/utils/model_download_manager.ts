import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import os from "node:os";
import { app } from "electron";
import log from "electron-log";

const logger = log.scope("model-download");

// ─── Storage location ────────────────────────────────────────────────────────

export function getModelsDir(): string {
  // userData is the canonical Electron-managed dir; ~/.../models keeps it
  // out of the project source tree and survives app updates.
  const dir = path.join(app.getPath("userData"), "models");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safePathSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Local path on disk for a given (repoId, filename). */
export function localModelPath(repoId: string, fileName: string): string {
  const [owner, repo] = repoId.split("/");
  const dir = path.join(
    getModelsDir(),
    safePathSegment(owner ?? "huggingface"),
    safePathSegment(repo ?? repoId),
  );
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, fileName);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DownloadProgress {
  id: string;
  repoId: string;
  fileName: string;
  totalBytes: number;
  receivedBytes: number;
  bytesPerSecond: number;
  state:
    | "queued"
    | "downloading"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled";
  error?: string;
  startedAt: number;
  finishedAt?: number;
  destPath: string;
}

interface DownloadJob extends DownloadProgress {
  abort: AbortController;
  // tick stats
  lastSampleAt: number;
  lastSampleBytes: number;
  // chunk workers
  chunks: { start: number; end: number; received: number; done: boolean }[];
  url: string;
  headers: Record<string, string>;
  onUpdate?: (p: DownloadProgress) => void;
}

const jobs = new Map<string, DownloadJob>();
const PARALLEL_CONNECTIONS_DEFAULT = 8;
const MIN_CHUNK_BYTES = 8 * 1024 * 1024; // don't slice smaller than 8 MB
const PROGRESS_INTERVAL_MS = 250;

let progressTimer: NodeJS.Timeout | null = null;
function ensureProgressTicker() {
  if (progressTimer) return;
  progressTimer = setInterval(() => {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.state !== "downloading") continue;
      const dt = now - job.lastSampleAt;
      if (dt <= 0) continue;
      const dBytes = job.receivedBytes - job.lastSampleBytes;
      job.bytesPerSecond = (dBytes * 1000) / dt;
      job.lastSampleAt = now;
      job.lastSampleBytes = job.receivedBytes;
      job.onUpdate?.(snapshot(job));
    }
    if (jobs.size === 0) {
      clearInterval(progressTimer!);
      progressTimer = null;
    }
  }, PROGRESS_INTERVAL_MS);
}

function snapshot(job: DownloadJob): DownloadProgress {
  return {
    id: job.id,
    repoId: job.repoId,
    fileName: job.fileName,
    totalBytes: job.totalBytes,
    receivedBytes: job.receivedBytes,
    bytesPerSecond: job.bytesPerSecond,
    state: job.state,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    destPath: job.destPath,
  };
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

interface HeadResult {
  url: string; // post-redirect
  size: number;
  acceptRanges: boolean;
  etag?: string;
}

function makeRequest(
  url: URL,
  init: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: init.method ?? "GET",
        headers: {
          "User-Agent": "OrianBuilder/1.0",
          Accept: "*/*",
          ...init.headers,
        },
      },
      (res) => resolve(res),
    );
    req.on("error", reject);
    if (init.signal) {
      const onAbort = () => req.destroy(new Error("aborted"));
      if (init.signal.aborted) onAbort();
      else init.signal.addEventListener("abort", onAbort, { once: true });
    }
    req.end();
  });
}

async function followRedirects(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  method = "HEAD",
  maxHops = 8,
): Promise<{ res: http.IncomingMessage; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop < maxHops; hop++) {
    const res = await makeRequest(new URL(current), {
      method,
      headers,
      signal,
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      const next = new URL(res.headers.location, current).toString();
      // drain
      res.resume();
      current = next;
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new Error(`Too many redirects starting from ${url}`);
}

async function probe(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<HeadResult> {
  // Some CDNs don't allow HEAD on signed URLs — fall back to a tiny GET range.
  let { res, finalUrl } = await followRedirects(url, headers, signal, "HEAD");
  if ((res.statusCode ?? 0) >= 400) {
    res.resume();
    const got = await followRedirects(
      url,
      { ...headers, Range: "bytes=0-0" },
      signal,
      "GET",
    );
    res = got.res;
    finalUrl = got.finalUrl;
  }
  const status = res.statusCode ?? 0;
  if (status >= 400) {
    res.resume();
    throw new Error(`HTTP ${status} probing ${url}`);
  }

  const acceptRanges =
    res.headers["accept-ranges"] === "bytes" || status === 206;
  let size = 0;
  const cr = res.headers["content-range"];
  if (typeof cr === "string") {
    const m = cr.match(/\/(\d+)/);
    if (m) size = parseInt(m[1], 10);
  }
  if (!size) {
    const cl = res.headers["content-length"];
    if (typeof cl === "string") size = parseInt(cl, 10) || 0;
  }
  const etag =
    typeof res.headers["etag"] === "string" ? res.headers["etag"] : undefined;
  res.resume();
  return { url: finalUrl, size, acceptRanges, etag };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface StartDownloadOpts {
  url: string;
  repoId: string;
  fileName: string;
  /** Bearer token (HF token) — optional for gated/private repos. */
  authToken?: string;
  parallelConnections?: number;
  onUpdate?: (p: DownloadProgress) => void;
}

export function listDownloads(): DownloadProgress[] {
  return Array.from(jobs.values()).map(snapshot);
}

export function getDownload(id: string): DownloadProgress | null {
  const j = jobs.get(id);
  return j ? snapshot(j) : null;
}

export function cancelDownload(id: string): boolean {
  const j = jobs.get(id);
  if (!j) return false;
  j.state = "cancelled";
  j.abort.abort();
  // Best-effort cleanup of the partial file (user can restart cleanly).
  try {
    if (fs.existsSync(j.destPath)) fs.unlinkSync(j.destPath);
  } catch {
    /* ignore */
  }
  jobs.delete(id);
  return true;
}

export function clearCompleted(): number {
  let n = 0;
  for (const [id, j] of jobs.entries()) {
    if (
      j.state === "completed" ||
      j.state === "failed" ||
      j.state === "cancelled"
    ) {
      jobs.delete(id);
      n++;
    }
  }
  return n;
}

export async function startDownload(
  opts: StartDownloadOpts,
): Promise<DownloadProgress> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const destPath = localModelPath(opts.repoId, opts.fileName);
  const partPath = destPath + ".part";

  const headers: Record<string, string> = {};
  if (opts.authToken) headers.Authorization = `Bearer ${opts.authToken}`;

  const abort = new AbortController();

  const job: DownloadJob = {
    id,
    repoId: opts.repoId,
    fileName: opts.fileName,
    destPath,
    totalBytes: 0,
    receivedBytes: 0,
    bytesPerSecond: 0,
    state: "queued",
    startedAt: Date.now(),
    lastSampleAt: Date.now(),
    lastSampleBytes: 0,
    chunks: [],
    url: opts.url,
    headers,
    abort,
    onUpdate: opts.onUpdate,
  };
  jobs.set(id, job);
  ensureProgressTicker();

  // Refuse if already exists & complete.
  if (fs.existsSync(destPath)) {
    const stat = fs.statSync(destPath);
    job.totalBytes = stat.size;
    job.receivedBytes = stat.size;
    job.state = "completed";
    job.finishedAt = Date.now();
    opts.onUpdate?.(snapshot(job));
    return snapshot(job);
  }

  // Probe in the background
  probe(opts.url, headers, abort.signal)
    .then(async (info) => {
      job.url = info.url;
      job.totalBytes = info.size;
      job.state = "downloading";
      opts.onUpdate?.(snapshot(job));

      try {
        if (info.size > 0 && info.acceptRanges) {
          await runParallel(
            job,
            partPath,
            opts.parallelConnections ?? PARALLEL_CONNECTIONS_DEFAULT,
          );
        } else {
          await runSingle(job, partPath);
        }
        await fs.promises.rename(partPath, destPath);
        job.state = "completed";
        job.finishedAt = Date.now();
        opts.onUpdate?.(snapshot(job));
        logger.info(
          `Downloaded ${opts.repoId}/${opts.fileName} -> ${destPath}`,
        );
      } catch (err: any) {
        if ((job.state as DownloadProgress["state"]) === "cancelled") return;
        job.state = "failed";
        job.error = err?.message ?? String(err);
        job.finishedAt = Date.now();
        opts.onUpdate?.(snapshot(job));
        try {
          if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
        } catch {
          /* ignore */
        }
        logger.error(`Download failed ${opts.repoId}/${opts.fileName}:`, err);
      }
    })
    .catch((err) => {
      job.state = "failed";
      job.error = err?.message ?? String(err);
      job.finishedAt = Date.now();
      opts.onUpdate?.(snapshot(job));
    });

  return snapshot(job);
}

// ─── Engines ────────────────────────────────────────────────────────────────

async function runSingle(job: DownloadJob, partPath: string): Promise<void> {
  const handle = await fs.promises.open(partPath, "w");
  try {
    const { res } = await followRedirects(
      job.url,
      job.headers,
      job.abort.signal,
      "GET",
    );
    if ((res.statusCode ?? 0) >= 400) {
      res.resume();
      throw new Error(`HTTP ${res.statusCode}`);
    }
    if (!job.totalBytes) {
      const cl = res.headers["content-length"];
      if (typeof cl === "string") job.totalBytes = parseInt(cl, 10) || 0;
    }
    let pos = 0;
    for await (const chunk of res) {
      const buf = chunk as Buffer;
      await handle.write(buf, 0, buf.length, pos);
      pos += buf.length;
      job.receivedBytes = pos;
      if (job.abort.signal.aborted) throw new Error("aborted");
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function runParallel(
  job: DownloadJob,
  partPath: string,
  parallel: number,
): Promise<void> {
  const total = job.totalBytes;
  // Slice into roughly equal chunks, but respect MIN_CHUNK_BYTES.
  const chunkCount = Math.max(
    1,
    Math.min(parallel, Math.ceil(total / MIN_CHUNK_BYTES)),
  );
  const chunkSize = Math.ceil(total / chunkCount);

  job.chunks = [];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(total - 1, start + chunkSize - 1);
    job.chunks.push({ start, end, received: 0, done: false });
  }

  // Pre-allocate the file at full size so concurrent writes don't race.
  const handle = await fs.promises.open(partPath, "w");
  try {
    await handle.truncate(total);

    await Promise.all(
      job.chunks.map((c, idx) => downloadRange(job, handle, c, idx)),
    );
  } finally {
    await handle.close().catch(() => {});
  }
}

async function downloadRange(
  job: DownloadJob,
  handle: fs.promises.FileHandle,
  chunk: { start: number; end: number; received: number; done: boolean },
  idx: number,
): Promise<void> {
  const headers = {
    ...job.headers,
    Range: `bytes=${chunk.start}-${chunk.end}`,
  };
  let attempt = 0;
  // Up to 3 retries for transient errors. Each retry resumes from the partial offset.
  while (true) {
    try {
      const fromOffset = chunk.start + chunk.received;
      if (fromOffset > chunk.end) {
        chunk.done = true;
        return;
      }
      const rangeHeaders = {
        ...headers,
        Range: `bytes=${fromOffset}-${chunk.end}`,
      };
      const { res } = await followRedirects(
        job.url,
        rangeHeaders,
        job.abort.signal,
        "GET",
      );
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode} on chunk ${idx}`);
      }
      let pos = fromOffset;
      for await (const piece of res) {
        const buf = piece as Buffer;
        await handle.write(buf, 0, buf.length, pos);
        pos += buf.length;
        const delta = buf.length;
        chunk.received += delta;
        job.receivedBytes += delta;
        if (job.abort.signal.aborted) throw new Error("aborted");
      }
      chunk.done = true;
      return;
    } catch (err: any) {
      if (job.abort.signal.aborted) throw err;
      if (attempt++ >= 3) throw err;
      logger.warn(
        `Chunk ${idx} attempt ${attempt} failed (${err?.message ?? err}), retrying...`,
      );
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

// ─── Local library ───────────────────────────────────────────────────────────

export interface LocalModelEntry {
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  modifiedAt: number;
  // Inferred from on-disk path: <models>/<owner>/<repo>/<file>
  repoId: string | null;
}

export function listLocalModels(): LocalModelEntry[] {
  const root = getModelsDir();
  const out: LocalModelEntry[] = [];
  if (!fs.existsSync(root)) return out;

  for (const owner of fs.readdirSync(root)) {
    const ownerDir = path.join(root, owner);
    if (!fs.statSync(ownerDir).isDirectory()) continue;
    for (const repo of fs.readdirSync(ownerDir)) {
      const repoDir = path.join(ownerDir, repo);
      if (!fs.statSync(repoDir).isDirectory()) continue;
      for (const f of fs.readdirSync(repoDir)) {
        if (!/\.gguf$/i.test(f)) continue;
        const full = path.join(repoDir, f);
        const stat = fs.statSync(full);
        out.push({
          filePath: full,
          fileName: f,
          fileSizeBytes: stat.size,
          modifiedAt: stat.mtimeMs,
          repoId: `${owner}/${repo}`,
        });
      }
    }
  }
  // Allow loose .gguf files dropped directly in the models dir too.
  for (const f of fs.readdirSync(root)) {
    if (!/\.gguf$/i.test(f)) continue;
    const full = path.join(root, f);
    if (!fs.statSync(full).isFile()) continue;
    const stat = fs.statSync(full);
    out.push({
      filePath: full,
      fileName: f,
      fileSizeBytes: stat.size,
      modifiedAt: stat.mtimeMs,
      repoId: null,
    });
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export function deleteLocalModel(filePath: string): {
  success: boolean;
  error?: string;
} {
  try {
    const root = getModelsDir();
    const norm = path.resolve(filePath);
    // Refuse to delete anything outside the models directory.
    if (!norm.startsWith(path.resolve(root))) {
      return {
        success: false,
        error: "Refusing to delete files outside the models directory",
      };
    }
    if (fs.existsSync(norm)) fs.unlinkSync(norm);
    // Clean up empty parent dirs (owner/repo) but never the root.
    let dir = path.dirname(norm);
    while (dir.startsWith(root) && dir !== root) {
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        else break;
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// Free disk space helper (best-effort)
export function getModelsDirInfo() {
  const dir = getModelsDir();
  let totalBytes = 0;
  for (const m of listLocalModels()) totalBytes += m.fileSizeBytes;
  let freeBytes = 0;
  try {
    // statfs is Node 18+ on POSIX; on Windows we approximate via os.freemem fallback.
    const sf = (fs as any).statfsSync ? (fs as any).statfsSync(dir) : null;
    if (sf) freeBytes = Number(sf.bavail) * Number(sf.bsize);
    else freeBytes = os.freemem();
  } catch {
    freeBytes = 0;
  }
  return { dir, totalBytes, freeBytes };
}
