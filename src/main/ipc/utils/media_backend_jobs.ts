import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import { MEDIA_AI_SERVER_URL } from "@/ipc/utils/media_ai_backend";

// =============================================================================
// Submit-and-poll client for the Python media backend's /v1/jobs API.
// =============================================================================
//
// Media generation regularly takes longer than any single HTTP request is
// allowed to live: Node's fetch (undici) aborts after 300 s without response
// headers, which is exactly how long-running synchronous generation calls
// used to die with a bare "fetch failed". Every request below returns in
// milliseconds; the waiting happens client-side in a poll loop that also
// surfaces stage/progress and supports cancellation via AbortSignal.
// =============================================================================

const logger = log.scope("media-backend-jobs");

export interface MediaJobProgress {
  stage: string;
  /** 0..1, or null when the stage has no measurable progress. */
  progress: number | null;
}

export interface RunBackendJobOptions {
  onProgress?: (p: MediaJobProgress) => void;
  /** Overall deadline for the whole job. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_JOB_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Polls that may fail in a row (backend busy loading a model, transient
 *  socket hiccup) before we declare the job lost. */
const MAX_CONSECUTIVE_POLL_FAILURES = 8;

interface BackendJobStatus {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  stage: string;
  progress: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const externalSignal = init?.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else
    externalSignal?.addEventListener("abort", abortFromExternal, {
      once: true,
    });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function cancelBackendJob(jobId: string): Promise<void> {
  try {
    await fetchWithTimeout(`${MEDIA_AI_SERVER_URL}/v1/jobs/${jobId}/cancel`, {
      method: "POST",
    });
  } catch {
    // Best-effort — the backend prunes orphaned jobs on its own.
  }
}

/**
 * Submits a generation job to the local media backend and polls it to
 * completion. Returns the job's result payload. Throws on job error,
 * cancellation, lost backend, or overall timeout.
 */
export async function runBackendMediaJob(
  kind: "video" | "image" | "music" | "tts",
  params: Record<string, unknown>,
  options: RunBackendJobOptions = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const submitResponse = await fetchWithTimeout(
    `${MEDIA_AI_SERVER_URL}/v1/jobs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, params }),
      signal: options.signal,
    },
  );
  if (!submitResponse.ok) {
    const detail = await submitResponse.text().catch(() => "");
    throw new Error(
      `media job submit failed (${submitResponse.status}): ${detail.slice(0, 300)}`,
    );
  }
  const { job_id: jobId } = (await submitResponse.json()) as { job_id: string };
  logger.info(`submitted ${kind} job ${jobId}`);

  const deadline = Date.now() + timeoutMs;
  let consecutiveFailures = 0;
  let lastReported = "";

  for (;;) {
    if (options.signal?.aborted) {
      await cancelBackendJob(jobId);
      throw new Error(`${kind} generation was cancelled`);
    }
    if (Date.now() > deadline) {
      await cancelBackendJob(jobId);
      throw new Error(
        `${kind} generation timed out after ${Math.round(timeoutMs / 60000)} min`,
      );
    }

    let status: BackendJobStatus;
    try {
      const response = await fetchWithTimeout(
        `${MEDIA_AI_SERVER_URL}/v1/jobs/${jobId}`,
        { signal: options.signal },
      );
      if (response.status === 404) {
        // The backend restarted (crash / manual restart) and lost the job.
        throw new Error(
          `the media backend restarted while running this ${kind} job — retry the job`,
        );
      }
      if (!response.ok) {
        throw new Error(`status poll failed: HTTP ${response.status}`);
      }
      status = (await response.json()) as BackendJobStatus;
      consecutiveFailures = 0;
    } catch (err) {
      if (err instanceof Error && err.message.includes("backend restarted")) {
        throw err;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        await cancelBackendJob(jobId);
        throw new Error(
          `lost contact with the media backend during ${kind} generation (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
      await sleep(pollIntervalMs, options.signal);
      continue;
    }

    if (options.onProgress) {
      const key = `${status.stage}:${status.progress ?? ""}`;
      if (key !== lastReported) {
        lastReported = key;
        options.onProgress({
          stage: status.stage,
          progress: status.progress ?? null,
        });
      }
    }

    if (status.status === "done") {
      return status.result ?? {};
    }
    if (status.status === "error") {
      throw new Error(status.error ?? `${kind} generation failed`);
    }
    if (status.status === "cancelled") {
      throw new Error(`${kind} generation was cancelled`);
    }

    await sleep(pollIntervalMs, options.signal);
  }
}

/**
 * Downloads a backend-relative output URL (e.g. "/outputs/v1-abc.mp4") to
 * `outputPath`, creating parent directories.
 */
export async function downloadBackendFile(
  urlPath: string,
  outputPath: string,
): Promise<void> {
  const response = await fetchWithTimeout(
    `${MEDIA_AI_SERVER_URL}${urlPath}`,
    undefined,
    5 * 60 * 1000,
  );
  if (!response.ok) {
    throw new Error(`fetch of generated file failed: ${response.status}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buf);
}
