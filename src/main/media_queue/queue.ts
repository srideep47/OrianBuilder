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
import type { ParsedStoryboard } from "./script_parser";

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
//
// AV models (LTX-2) return clips that already carry a synced soundtrack
// (`hasAudio` on the generation result). The pipeline detects this and skips
// the separate music + mux pass: storyboards concat with `keepAudio` so the
// per-scene sound survives the edit, and video_audio jobs deliver directly.
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
  /** Parse a storyboard script into ordered scenes. Throws on unparseable input. */
  parseScript: (script: string) => Promise<ParsedStoryboard>;
  /** Concatenate ordered clips into one normalized mp4 at outputPath. With
   *  keepAudio, the clips' own (synced) audio tracks carry into the output. */
  concat: (
    inputPaths: string[],
    target: { width: number; height: number; fps: number },
    outputPath: string,
    opts?: { keepAudio?: boolean },
  ) => Promise<void>;
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

/** Final assembled-video resolution per aspect ratio (concat re-encode target;
 *  individual clips are upscaled/padded to this). */
const FINAL_DIMENSIONS: Record<
  MediaAspectRatio,
  { width: number; height: number }
> = {
  "16:9": { width: 1280, height: 720 },
  "9:16": { width: 720, height: 1280 },
  "1:1": { width: 1024, height: 1024 },
  "4:3": { width: 1152, height: 864 },
  "3:4": { width: 864, height: 1152 },
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
    job.warning = undefined;
    job.scenes = undefined;
    job.videoTier = undefined;
    job.syncedAudio = undefined;
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
  ): Promise<{ outputPath: string; hasAudio: boolean; tier?: string }> {
    job.stage = stage;
    job.status = "running";
    this.touch(job);
    const outputPath = this.tmpPath(EXT_BY_MODEL_TYPE[modelType]);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    // Surface within-stage progress (model download %, denoising steps) in the
    // queue UI. Persist/emit at most ~once per second — every touch() writes
    // the whole store to disk and broadcasts to all windows.
    let lastEmit = 0;
    const result = await this.deps!.generate({
      modelType,
      prompt,
      outputPath,
      options,
      onProgress: (p) => {
        const pct =
          p.progress != null ? ` ${Math.round(p.progress * 100)}%` : "";
        job.stage = `${stage} · ${p.stage}${pct}`;
        const now = Date.now();
        if (now - lastEmit >= 1000) {
          lastEmit = now;
          this.touch(job);
        }
      },
    });
    if (!result.success) {
      throw new Error(result.error ?? `${stage} generation failed`);
    }
    if ((result.error ?? "").toLowerCase().includes("placeholder")) {
      throw new Error(
        `${stage}: no media provider produced output — set up the Media AI backend (or a capable peer) and retry`,
      );
    }
    return {
      outputPath: result.outputPath,
      hasAudio: result.hasAudio === true,
      tier: result.tier,
    };
  }

  /**
   * Storyboard pipeline: parse the script → generate every scene's clip in
   * playback order → auto-edit (concat, normalized to the final resolution)
   * → lay one matched soundtrack over the whole video → import the final mp4.
   * Returns the stored fileName, or null when the job was cancelled mid-way.
   */
  private async runStoryboard(
    job: MediaJob,
    cleanupPaths: string[],
    share: boolean,
  ): Promise<string | null> {
    const deps = this.deps!;

    // 1. Parse the script into ordered scenes (deterministic, LLM fallback).
    job.stage = "parsing script";
    this.touch(job);
    const storyboard = await deps.parseScript(job.prompt);
    const jobScenes: NonNullable<MediaJob["scenes"]> = storyboard.scenes.map(
      (s) => ({
        index: s.index,
        title: s.title,
        prompt: s.prompt,
        durationSec: s.durationSec,
        status: "pending",
      }),
    );
    job.scenes = jobScenes;
    this.touch(job);

    // 2. Generate each scene clip in order. The global style is prepended to
    //    every prompt so characters/palette stay consistent across clips. The
    //    aspect ratio rides along so each tier renders at its own pixel
    //    budget in the requested shape (16:9, 9:16, …). AV tiers (LTX-2)
    //    return clips with synced audio — tracked per clip below.
    const clipPaths: string[] = [];
    let allClipsHaveAudio = true;
    const total = storyboard.scenes.length;
    for (let i = 0; i < total; i++) {
      if (this.cancelled(job.id)) return null;
      const scene = storyboard.scenes[i];
      const jobScene = jobScenes[i];
      jobScene.status = "generating";
      try {
        const fullPrompt = storyboard.style
          ? `${storyboard.style}. ${scene.prompt}`
          : scene.prompt;
        const clip = await this.generateStage(
          job,
          `scene ${i + 1}/${total}`,
          "video",
          fullPrompt,
          {
            aspect_ratio: job.aspectRatio,
            ...(scene.durationSec ? { duration_s: scene.durationSec } : {}),
          },
        );
        cleanupPaths.push(clip.outputPath);
        clipPaths.push(clip.outputPath);
        allClipsHaveAudio &&= clip.hasAudio;
        if (clip.tier && !job.videoTier) job.videoTier = clip.tier;
        jobScene.status = "done";
        this.touch(job);
      } catch (err) {
        jobScene.status = "failed";
        this.touch(job);
        throw err;
      }
    }
    if (this.cancelled(job.id)) return null;
    const syncedAudio = clipPaths.length > 0 && allClipsHaveAudio;
    job.syncedAudio = syncedAudio;

    // 3. Auto-edit: concat the clips in scene order, normalized to the final
    //    resolution/fps. Synced-audio clips keep their own tracks through the
    //    edit. A single-scene storyboard skips the concat.
    const finalDims = FINAL_DIMENSIONS[job.aspectRatio];
    let assembledPath: string;
    if (clipPaths.length === 1) {
      assembledPath = clipPaths[0];
    } else {
      job.stage = "editing";
      this.touch(job);
      assembledPath = this.tmpPath("mp4");
      await fs.mkdir(path.dirname(assembledPath), { recursive: true });
      await deps.concat(clipPaths, { ...finalDims, fps: 24 }, assembledPath, {
        keepAudio: syncedAudio,
      });
      cleanupPaths.push(assembledPath);
    }
    if (this.cancelled(job.id)) return null;

    // 4. Soundtrack: one matched audio track over the whole video (video
    //    duration wins in the mux — short audio padded, long audio trimmed).
    //    Skipped entirely when the clips already carry synced audio from the
    //    model — muxing would replace the matched sound with generic music.
    const totalDuration = storyboard.scenes.reduce(
      (sum, s) => sum + (s.durationSec ?? 6),
      0,
    );
    const audioKind = job.audioKind ?? "music";
    const audioPrompt =
      job.audioPrompt?.trim() ||
      (audioKind === "music"
        ? `Soundtrack for this video: ${storyboard.style ?? storyboard.scenes[0].prompt}`
        : undefined);
    // The soundtrack is best-effort: a missing music runtime/weights (or any
    // audio failure) must not throw away the clips we just spent an hour
    // rendering — deliver the video without audio and say why.
    let finalPath = assembledPath;
    if (syncedAudio) {
      logger.info(
        `job ${job.id}: clips carry synced audio (${job.videoTier ?? "AV tier"}) — skipping soundtrack`,
      );
      if (job.audioPrompt?.trim()) {
        job.warning =
          "soundtrack prompt ignored: the video model generated its own synced audio";
        this.touch(job);
      }
    } else if (audioPrompt) {
      try {
        const audio = await this.generateStage(
          job,
          "soundtrack",
          audioKind === "music" ? "music" : "audio",
          audioPrompt,
          { duration_s: Math.min(totalDuration, 600) },
        );
        cleanupPaths.push(audio.outputPath);
        if (this.cancelled(job.id)) return null;

        job.stage = "mux";
        this.touch(job);
        const muxedPath = this.tmpPath("mp4");
        await fs.mkdir(path.dirname(muxedPath), { recursive: true });
        await deps.mux(assembledPath, audio.outputPath, muxedPath);
        cleanupPaths.push(muxedPath);
        finalPath = muxedPath;
      } catch (err) {
        if (this.cancelled(job.id)) return null;
        const reason =
          err instanceof Error ? err.message.split("\n")[0] : String(err);
        logger.warn(
          `job ${job.id}: soundtrack failed — delivering video without audio (${reason})`,
        );
        job.warning = `soundtrack skipped: ${reason}`;
        this.touch(job);
        finalPath = assembledPath;
      }
    }

    // 5. Import the finished video into the library.
    const title = storyboard.style
      ? `storyboard: ${storyboard.style.slice(0, 60)}`
      : `storyboard: ${jobScenes[0].title}`;
    return deps.importToStore(finalPath, { prompt: title, share });
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

      if (job.kind === "storyboard") {
        const fileName = await this.runStoryboard(job, cleanupPaths, share);
        if (fileName === null) return; // cancelled between scenes
        outputs.push(fileName);
      } else if (job.kind === "video_audio") {
        const video = await this.generateStage(
          job,
          "video",
          "video",
          job.prompt,
          {
            aspect_ratio: job.aspectRatio,
            ...(job.durationSec ? { duration_s: job.durationSec } : {}),
          },
        );
        cleanupPaths.push(video.outputPath);
        job.videoTier = video.tier;
        job.syncedAudio = video.hasAudio;
        if (this.cancelled(job.id)) return;

        if (video.hasAudio) {
          // The model produced synced audio with the frames — muxing a
          // separate track over it would replace the matched sound.
          if (job.audioPrompt?.trim()) {
            job.warning =
              "audio prompt ignored: the video model generated its own synced audio";
          }
          outputs.push(
            await deps.importToStore(video.outputPath, {
              prompt: job.prompt,
              share,
            }),
          );
        } else {
          const audioKind = job.audioKind ?? "music";
          const audioPrompt =
            job.audioPrompt?.trim() ||
            (audioKind === "music"
              ? `Background music matching: ${job.prompt}`
              : job.prompt);
          const audio = await this.generateStage(
            job,
            "audio",
            audioKind === "music" ? "music" : "audio",
            audioPrompt,
            job.durationSec ? { duration_s: job.durationSec } : {},
          );
          cleanupPaths.push(audio.outputPath);
          if (this.cancelled(job.id)) return;

          job.stage = "mux";
          this.touch(job);
          const muxedPath = this.tmpPath("mp4");
          await fs.mkdir(path.dirname(muxedPath), { recursive: true });
          await deps.mux(video.outputPath, audio.outputPath, muxedPath);
          cleanupPaths.push(muxedPath);

          outputs.push(
            await deps.importToStore(muxedPath, { prompt: job.prompt, share }),
          );
        }
      } else {
        const modelType = job.kind === "speech" ? ("audio" as const) : job.kind;
        const dims =
          job.kind === "image" ? IMAGE_DIMENSIONS[job.aspectRatio] : undefined;
        const result = await this.generateStage(
          job,
          job.kind,
          modelType,
          job.prompt,
          {
            ...dims,
            ...(job.kind === "video" ? { aspect_ratio: job.aspectRatio } : {}),
            ...(job.durationSec ? { duration_s: job.durationSec } : {}),
          },
        );
        cleanupPaths.push(result.outputPath);
        if (job.kind === "video") {
          job.videoTier = result.tier;
          job.syncedAudio = result.hasAudio;
        }
        outputs.push(
          await deps.importToStore(result.outputPath, {
            prompt: job.prompt,
            share,
          }),
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
