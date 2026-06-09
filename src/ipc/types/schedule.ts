import { z } from "zod";
import {
  defineContract,
  defineEvent,
  createClient,
  createEventClient,
} from "../contracts/core";

export const SchedulePlatformSchema = z.enum(["youtube", "instagram"]);
export type SchedulePlatform = z.infer<typeof SchedulePlatformSchema>;

export const ScheduleStatusSchema = z.enum([
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
]);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

export const YouTubeSchedulePayloadSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  privacy: z.enum(["public", "unlisted", "private"]),
});

export const InstagramSchedulePayloadSchema = z.object({
  caption: z.string(),
});

export const ScheduleJobSchema = z.object({
  id: z.string(),
  platform: SchedulePlatformSchema,
  fileName: z.string(),
  scheduledAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: ScheduleStatusSchema,
  youtube: YouTubeSchedulePayloadSchema.optional(),
  instagram: InstagramSchedulePayloadSchema.optional(),
  result: z
    .object({
      url: z.string().optional(),
      videoId: z.string().optional(),
    })
    .optional(),
  error: z.string().optional(),
});
export type ScheduleJob = z.infer<typeof ScheduleJobSchema>;

export const scheduleContracts = {
  list: defineContract({
    channel: "schedule:list",
    input: z.void(),
    output: z.array(ScheduleJobSchema),
  }),
  /** Queue a new YouTube post for later. Returns the persisted job. */
  scheduleYouTube: defineContract({
    channel: "schedule:youtube",
    input: z.object({
      fileName: z.string(),
      scheduledAt: z.number(),
      title: z.string().min(1),
      description: z.string().optional(),
      privacy: z.enum(["public", "unlisted", "private"]),
    }),
    output: ScheduleJobSchema,
  }),
  /** Queue a new Instagram share-assist for later. */
  scheduleInstagram: defineContract({
    channel: "schedule:instagram",
    input: z.object({
      fileName: z.string(),
      scheduledAt: z.number(),
      caption: z.string(),
    }),
    output: ScheduleJobSchema,
  }),
  /** Cancel a pending job (no-op if it has already run). */
  cancel: defineContract({
    channel: "schedule:cancel",
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
  /** Delete a job entirely — pending or terminal. */
  remove: defineContract({
    channel: "schedule:remove",
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
  /** Toggle the "Run in background" lifecycle setting. */
  setBackgroundMode: defineContract({
    channel: "schedule:set-background-mode",
    input: z.object({ enabled: z.boolean() }),
    output: z.object({ enabled: z.boolean() }),
  }),
  /** Read the current background-mode state (mirrors the setting). */
  getBackgroundMode: defineContract({
    channel: "schedule:get-background-mode",
    input: z.void(),
    output: z.object({ enabled: z.boolean() }),
  }),
} as const;

export const scheduleClient = createClient(scheduleContracts);

export const scheduleEvents = {
  /** Queue contents changed (added, status update, cancelled, pruned). */
  changed: defineEvent({
    channel: "schedule:changed",
    payload: z.object({ count: z.number() }),
  }),
  /** Live upload progress for a YouTube job. */
  progress: defineEvent({
    channel: "schedule:progress",
    payload: z.object({
      id: z.string(),
      platform: SchedulePlatformSchema,
      percent: z.number(),
    }),
  }),
  /**
   * An Instagram (share-assist) job's time has come. The renderer should
   * bring the window forward and open the IG share dialog for `fileName`.
   */
  fired: defineEvent({
    channel: "schedule:fired",
    payload: z.object({
      id: z.string(),
      platform: SchedulePlatformSchema,
      fileName: z.string(),
    }),
  }),
} as const;

export const scheduleEventClient = createEventClient(scheduleEvents);
