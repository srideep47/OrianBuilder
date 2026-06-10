import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import log from "electron-log";
import { getUserDataPath } from "@/paths/paths";
import type {
  MediaJob,
  MediaJobRequester,
  MediaAspectRatio,
  EnqueueMediaJobParams,
} from "@/ipc/types/media_queue";
import type {
  MediaGenerationRequest,
  MediaGenerationResult,
} from "@/main/ipc/utils/model_orchestrator";

// =============================================================================
// Orion Media Queue — core store + sequential worker
// =============================================================================
//
// Jobs (from this device or trusted peers) are persisted to one JSON file and
// processed strictly one at a time, honoring the single-residency reality of
// local model hosting. Generation goes through the injected `generate` hook —
// the same dispatcher chain Orion flows use (P2P placement included) — so the
// queue stays free of backend imports and is unit-testable.
//
// "video_audio" jobs are a three-stage pipeline: generate the video, generate
// the matched audio (music or narration), then mux them into one mp4 via the
// injected `mux` hook (ffmpeg in the media backend).
// =============================================================================

const logger = log.scope("media-queue");

/** Hooks the IPC layer injects so the queue stays testable. */
export interface MediaQueueDeps {
  /** Run one generation request (dispatcher chain; P2P placement included). */
  generate: (request: MediaGenerationRequest) => Promise<MediaGenerationResult>;
  /** Mux audio onto video (video duration wins) into outputPath. Throws on failure. */
  mux: (
    videoPath: string,
    audioPath: string,
    outputPath: string,
  ) => Promise<void>;
  /** Import a finished file into the generated-media store; returns its fileName. */
  importToStore: (
    srcPath: string,
    opts: { prompt: string; share: boolean },
  ) => Promise<string>;
  /** Called on every job state change (renderer events + peer status updates). */
  onJobUpdate: (job: MediaJob) => void;
}

/** Per-kind dimensions for each aspect ratio, sized to the local backend's
 *  validation limits (images ≤1024, fallback video ≤512; richer models read
 *  their own settings from the hardware profile). All values divisible by 8. */
const IMAGE_DIMENSIONS: Record<
  MediaAspectRatio,
  { width: number; height: number }
> = {
  "16:9": { width: 1024, height: 576 },
  "9:16": { width: 576, height: 1024 },
  "1:1": { width: 1024, height: 1024 },
  "4:3": { width: 1024, height: 768 },
  "3:4": { width: 768, height: 1024 },
};

const VIDEO_DIMENSIONS: Record<
  MediaAspectRatio,
  { width: number; height: number }
> = {
  "16:9": { width: 512, height: 288 },
  "9:16": { width: 288, height: 512 },
  "1:1": { width: 448, height: 448 },
  "4:3": { width: 512, height: 384 },
  "3:4": { width: 384, height: 512 },
};

const EXT_BY_MODEL_TYPE: Record<string, string> = {
  image: "png",
  video: "mp4",
  music: "wav",
  audio: "wav",
};

function storeFile(): string {
  return path.join(getUserDataPath(), "media-queue", "jobs.json");
}

export class MediaJobQueue {
  private jobs = new Map<string, MediaJob>();
  private deps: MediaQueueDeps | null = null;
  private running = false;
  private loaded = false;

  setDeps(deps: MediaQueueDeps): void {
    this.deps = deps;
  }

  /** Load persisted jobs; jobs caught mid-run by a crash go back to queued. */
  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(storeFile(), "utf-8");
      const list = JSON.parse(raw) as MediaJob[];
      for (const job of list) {
        if (job.status === "running") {
          job.status = "queued";
          job.stage = undefined;
        }
        this.jobs.set(job.id, job);
      }
      logger.info(`loaded ${this.jobs.size} persisted media job(s)`);
    } catch {
      // No store yet — fine.
    }
    this.pump();
  }

  list(): MediaJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Enqueue a job hosted on THIS device. */
  enqueue(
    params: Omit<EnqueueMediaJobParams, "targetPeerId">,
    requestedBy: MediaJobRequester,
    jobId?: string,
  ): MediaJob {
    const job: MediaJob = {
      id: jobId ?? crypto.randomUUID(),
      kind: params.kind,
      prompt: params.prompt,
      audioPrompt: params.audioPrompt,
      audioKind: params.audioKind,
      aspectRatio: params.aspectRatio ?? "16:9",
      durationSec: params.durationSec,
      status: "queued",
      requestedBy,
      hostedBy: "local",
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.touch(job);
    this.pump();
    return job;
  }

  /** Record a mirror entry for a job we submitted to a peer's queue. */
  addMirror(job: MediaJob): void {
    this.jobs.set(job.id, job);
    this.touch(job);
  }

  /** Apply a status update from a peer for one of our mirror entries. */
  applyPeerStatus(update: {
    jobId: string;
    status: MediaJob["status"];
    stage?: string;
    error?: string;
    fileNames?: string[];
  }): void {
    const job = this.jobs.get(update.jobId);
    if (!job || job.hostedBy === "local") return;
    job.status = update.status;
    job.stage = update.stage;
    job.error = update.error;
    if (update.fileNames) job.outputFileNames = update.fileNames;
    if (update.status === "running" && !job.startedAt)
      job.startedAt = Date.now();
    if (
      update.status === "done" ||
      update.status === "failed" ||
      update.status === "cancelled"
    ) {
      job.finishedAt = Date.now();
    }
    this.touch(job);
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status !== "queued" && job.status !== "running") return false;
    // A running job checks this flag between stages; we can't abort mid-model.
    job.status = "cancelled";
    job.finishedAt = Date.now();
    this.touch(job);
    return true;
  }

  retry(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.hostedBy !== "local") return false;
    if (job.status !== "failed" && job.status !== "cancelled") return false;
    job.status = "queued";
    job.stage = undefined;
    job.error = undefined;
    job.startedAt = undefined;
    job.finishedAt = undefined;
    this.touch(job);
    this.pump();
    return true;
  }

  remove(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status === "running") return false;
    this.jobs.delete(jobId);
    void this.persist();
    return true;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private touch(job: MediaJob): void {
    void this.persist();
    this.deps?.onJobUpdate(job);
  }

  private async persist(): Promise<void> {
    try {
      const file = storeFile();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(this.list()), "utf-8");
    } catch (err) {
      logger.warn("failed to persist media queue", err);
    }
  }

  private nextQueued(): MediaJob | undefined {
    return [...this.jobs.values()]
      .filter((j) => j.status === "queued" && j.hostedBy === "local")
      .sort((a, b) => a.createdAt - b.createdAt)[0];
  }

  /** Start the worker loop if it isn't already draining the queue. */
  pump(): void {
    if (this.running || !this.deps) return;
    const job = this.nextQueued();
    if (!job) return;
    this.running = true;
    void this.runJob(job)
      .catch((err) => logger.error(`job ${job.id} crashed the worker:`, err))
      .finally(() => {
        this.running = false;
        this.pump();
      });
  }

  private cancelled(jobId: string): boolean {
    return this.jobs.get(jobId)?.status === "cancelled";
  }

  private tmpPath(ext: string): string {
    return path.join(
      os.tmpdir(),
      "orion-media-queue",
      `job-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`,
    );
  }

  private async generateStage(
    job: MediaJob,
    stage: string,
    modelType: "image" | "video" | "music" | "audio",
    prompt: string,
    options: Record<string, unknown>,
  ): Promise<string> {
    job.stage = stage;
    job.status = "running";
    this.touch(job);
    const outputPath = this.tmpPath(EXT_BY_MODEL_TYPE[modelType]);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const result = await this.deps!.generate({
      modelType,
      prompt,
      outputPath,
      options,
    });
    if (!result.success) {
      throw new Error(result.error ?? `${stage} generation failed`);
    }
    if ((result.error ?? "").toLowerCase().includes("placeholder")) {
      throw new Error(
        `${stage}: no media provider produced output — set up the Media AI backend (or a capable peer) and retry`,
      );
    }
    return result.outputPath;
  }

  private async runJob(job: MediaJob): Promise<void> {
    const deps = this.deps!;
    job.status = "running";
    job.startedAt = Date.now();
    this.touch(job);
    logger.info(`job ${job.id} starting (${job.kind}, ${job.aspectRatio})`);

    const cleanupPaths: string[] = [];
    try {
      const share = job.requestedBy.source === "peer";
      const outputs: string[] = [];

      if (job.kind === "video_audio") {
        const dims = VIDEO_DIMENSIONS[job.aspectRatio];
        const videoPath = await this.generateStage(
          job,
          "video",
          "video",
          job.prompt,
          {
            ...dims,
            ...(job.durationSec ? { duration_s: job.durationSec } : {}),
          },
        );
        cleanupPaths.push(videoPath);
        if (this.cancelled(job.id)) return;

        const audioKind = job.audioKind ?? "music";
        const audioPrompt =
          job.audioPrompt?.trim() ||
          (audioKind === "music"
            ? `Background music matching: ${job.prompt}`
            : job.prompt);
        const audioPath = await this.generateStage(
          job,
          "audio",
          audioKind === "music" ? "music" : "audio",
          audioPrompt,
          job.durationSec ? { duration_s: job.durationSec } : {},
        );
        cleanupPaths.push(audioPath);
        if (this.cancelled(job.id)) return;

        job.stage = "mux";
        this.touch(job);
        const muxedPath = this.tmpPath("mp4");
        await fs.mkdir(path.dirname(muxedPath), { recursive: true });
        await deps.mux(videoPath, audioPath, muxedPath);
        cleanupPaths.push(muxedPath);

        outputs.push(
          await deps.importToStore(muxedPath, { prompt: job.prompt, share }),
        );
      } else {
        const modelType = job.kind === "speech" ? ("audio" as const) : job.kind;
        const dims =
          job.kind === "image"
            ? IMAGE_DIMENSIONS[job.aspectRatio]
            : job.kind === "video"
              ? VIDEO_DIMENSIONS[job.aspectRatio]
              : undefined;
        const outPath = await this.generateStage(
          job,
          job.kind,
          modelType,
          job.prompt,
          {
            ...dims,
            ...(job.durationSec ? { duration_s: job.durationSec } : {}),
          },
        );
        cleanupPaths.push(outPath);
        outputs.push(
          await deps.importToStore(outPath, { prompt: job.prompt, share }),
        );
      }

      if (this.cancelled(job.id)) return;
      job.status = "done";
      job.stage = undefined;
      job.outputFileNames = outputs;
      job.finishedAt = Date.now();
      this.touch(job);
      logger.info(`job ${job.id} done: ${outputs.join(", ")}`);
    } catch (err) {
      if (this.cancelled(job.id)) return;
      job.status = "failed";
      job.stage = undefined;
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
      this.touch(job);
      logger.error(`job ${job.id} failed: ${job.error}`);
    } finally {
      for (const p of cleanupPaths) {
        await fs.rm(p, { force: true }).catch(() => undefined);
      }
    }
  }
}

let singleton: MediaJobQueue | null = null;

export function getMediaJobQueue(): MediaJobQueue {
  if (!singleton) singleton = new MediaJobQueue();
  return singleton;
}

/** Test-only: reset the singleton between tests. */
export function _resetMediaJobQueueForTests(): void {
  singleton = null;
}
