import { z } from "zod";
import {
  defineContract,
  defineEvent,
  createClient,
  createEventClient,
} from "../contracts/core";

// =============================================================================
// Orion Media Queue — batch prompts → assets, generated one at a time
// =============================================================================
//
// You (and trusted friends over P2P) queue generation requests: each job is a
// prompt plus targets (kind, aspect ratio, duration, optional matched audio).
// A single worker on the host device processes jobs sequentially — exactly one
// model resident at a time — and finished assets land in the generated-media
// store (Library → Media), auto-shared back to the friend who asked.
// =============================================================================

export const MediaJobKindSchema = z.enum([
  "image",
  "video",
  "music",
  "speech",
  /** Video plus a matched audio track (music or narration), muxed into one mp4. */
  "video_audio",
  /** A whole multi-scene script: parse → per-scene clips → auto-edit in order
   *  → one final video with a matched soundtrack. */
  "storyboard",
]);
export type MediaJobKind = z.infer<typeof MediaJobKindSchema>;

/** One parsed scene of a storyboard job (progress surfaced to the UI). */
export const MediaJobSceneSchema = z.object({
  index: z.number(),
  title: z.string(),
  prompt: z.string(),
  /** Spoken narration for this scene (TTS → muxed onto the clip, scene-aligned). */
  narration: z.string().optional(),
  durationSec: z.number().optional(),
  status: z.enum(["pending", "generating", "done", "failed"]),
});
export type MediaJobScene = z.infer<typeof MediaJobSceneSchema>;

export const MediaAspectRatioSchema = z.enum([
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
]);
export type MediaAspectRatio = z.infer<typeof MediaAspectRatioSchema>;

export const MediaJobStatusSchema = z.enum([
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
]);
export type MediaJobStatus = z.infer<typeof MediaJobStatusSchema>;

/** Who asked for this job. */
export const MediaJobRequesterSchema = z.object({
  source: z.enum(["local", "peer"]),
  /** Peer publicKey when source === "peer". */
  peerKey: z.string().optional(),
  displayName: z.string().optional(),
});
export type MediaJobRequester = z.infer<typeof MediaJobRequesterSchema>;

export const MediaJobSchema = z.object({
  id: z.string(),
  kind: MediaJobKindSchema,
  /** Main generation prompt (visual prompt for video_audio). */
  prompt: z.string(),
  /** For video_audio: music style prompt, or the narration text for speech. */
  audioPrompt: z.string().optional(),
  /** For video_audio: which audio goes under the video. Default music. */
  audioKind: z.enum(["music", "speech"]).optional(),
  aspectRatio: MediaAspectRatioSchema,
  /** Target duration in seconds (video/music/speech). */
  durationSec: z.number().optional(),
  /** Keyframe image path for i2v video jobs (see EnqueueMediaJobParams). */
  seedImagePath: z.string().optional(),
  status: MediaJobStatusSchema,
  /** Present while running: which stage is active (e.g. "video", "scene 3/12", "mux"). */
  stage: z.string().optional(),
  /** Storyboard jobs: the parsed scenes with per-scene progress. */
  scenes: z.array(MediaJobSceneSchema).optional(),
  /** Video tier that actually generated (e.g. "ltx-2-av-small") — for UI badges. */
  videoTier: z.string().optional(),
  /** True when the clips carry synced audio from the model itself, so no
   *  separate soundtrack pass was needed. */
  syncedAudio: z.boolean().optional(),
  error: z.string().optional(),
  /** Non-fatal degradation note (e.g. "soundtrack skipped: …"). The job still
   *  produced output; this explains what was left out and why. */
  warning: z.string().optional(),
  /** Files in the generated-media store produced by this job. */
  outputFileNames: z.array(z.string()).optional(),
  requestedBy: MediaJobRequesterSchema,
  /**
   * Where the job runs. "local" = this device hosts it. A peer publicKey means
   * this entry mirrors a job we submitted to that peer's queue; its status is
   * updated from their MEDIA_JOB_STATUS messages.
   */
  hostedBy: z.string(),
  /** Friendly label of the hosting device (for mirror entries). */
  hostLabel: z.string().optional(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
});
export type MediaJob = z.infer<typeof MediaJobSchema>;

export const EnqueueMediaJobParamsSchema = z.object({
  kind: MediaJobKindSchema,
  prompt: z.string().min(1),
  audioPrompt: z.string().optional(),
  audioKind: z.enum(["music", "speech"]).optional(),
  aspectRatio: MediaAspectRatioSchema.optional(),
  durationSec: z.number().positive().max(600).optional(),
  /** Absolute path to a keyframe image for video jobs — routes i2v-capable
   *  tiers (Wan 2.2 14B, LTX) into image-to-video. Storyboard jobs generate
   *  their own per-scene keyframes and ignore this. */
  seedImagePath: z.string().optional(),
  /** Submit to a trusted peer's queue instead of running locally. */
  targetPeerId: z.string().optional(),
});
export type EnqueueMediaJobParams = z.infer<typeof EnqueueMediaJobParamsSchema>;

export const mediaQueueContracts = {
  enqueue: defineContract({
    channel: "media-queue:enqueue",
    input: EnqueueMediaJobParamsSchema,
    output: MediaJobSchema,
  }),
  list: defineContract({
    channel: "media-queue:list",
    input: z.void(),
    output: z.array(MediaJobSchema),
  }),
  /** Cancel a queued job (a running job finishes its current stage first). */
  cancel: defineContract({
    channel: "media-queue:cancel",
    input: z.object({ jobId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
  /** Re-queue a failed or cancelled job. */
  retry: defineContract({
    channel: "media-queue:retry",
    input: z.object({ jobId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
  /** Remove a finished/failed/cancelled job from the list. */
  remove: defineContract({
    channel: "media-queue:remove",
    input: z.object({ jobId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
} as const;

export const mediaQueueClient = createClient(mediaQueueContracts);

export const mediaQueueEvents = {
  changed: defineEvent({
    channel: "media-queue:changed",
    payload: z.object({ jobs: z.array(MediaJobSchema) }),
  }),
} as const;

export const mediaQueueEventClient = createEventClient(mediaQueueEvents);
