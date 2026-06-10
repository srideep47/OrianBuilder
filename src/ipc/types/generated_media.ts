import { z } from "zod";
import {
  defineContract,
  defineEvent,
  createClient,
  createEventClient,
} from "../contracts/core";

export const GeneratedMediaKindSchema = z.enum([
  "image",
  "video",
  "audio",
  "model",
]);
export type GeneratedMediaKind = z.infer<typeof GeneratedMediaKindSchema>;

export const GeneratedMediaItemSchema = z.object({
  fileName: z.string(),
  kind: GeneratedMediaKindSchema,
  mimeType: z.string(),
  sizeBytes: z.number(),
  createdAt: z.number(),
  prompt: z.string().nullable(),
  shared: z.boolean(),
  thumbnail: z.string().nullable(),
});
export type GeneratedMediaItem = z.infer<typeof GeneratedMediaItemSchema>;

export const generatedMediaContracts = {
  list: defineContract({
    channel: "generated-media:list",
    input: z.void(),
    output: z.array(GeneratedMediaItemSchema),
  }),
  /** Save from a URL (e.g. the local media backend's /outputs/... path). */
  saveFromUrl: defineContract({
    channel: "generated-media:save-from-url",
    input: z.object({
      url: z.string(),
      prompt: z.string().nullable().optional(),
      ext: z.string().optional(),
    }),
    output: GeneratedMediaItemSchema,
  }),
  remove: defineContract({
    channel: "generated-media:remove",
    input: z.object({ fileName: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
  /**
   * Resolve the absolute on-disk path of a stored media item. The renderer
   * uses this for share-to-X-platform flows that need to hand the local file
   * off to the OS (e.g. `shell.showItemInFolder` for the Instagram share).
   * The store already validates the filename against directory traversal.
   */
  getFilePath: defineContract({
    channel: "generated-media:get-file-path",
    input: z.object({ fileName: z.string() }),
    output: z.object({ path: z.string() }),
  }),
  /** Toggle whether an item is shared with trusted peers. */
  setShared: defineContract({
    channel: "generated-media:set-shared",
    input: z.object({ fileName: z.string(), shared: z.boolean() }),
    output: z.object({ ok: z.boolean() }),
  }),
  /** Store a small thumbnail data-URL (generated in the renderer) for sharing. */
  setThumbnail: defineContract({
    channel: "generated-media:set-thumbnail",
    input: z.object({ fileName: z.string(), thumbnail: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
  /**
   * Concatenate a sequence of videos (already in the global media pool) into
   * a single new video. Order matters — `fileNames` plays in the order given.
   */
  concatVideos: defineContract({
    channel: "generated-media:concat-videos",
    input: z.object({
      fileNames: z.array(z.string()).min(2),
      mode: z.enum(["reencode", "copy"]).optional(),
      targetWidth: z.number().optional(),
      targetHeight: z.number().optional(),
      targetFps: z.number().optional(),
      prompt: z.string().nullable().optional(),
    }),
    output: GeneratedMediaItemSchema,
  }),
} as const;

export const generatedMediaClient = createClient(generatedMediaContracts);

export const generatedMediaEvents = {
  changed: defineEvent({
    channel: "generated-media:changed",
    payload: z.object({ count: z.number() }),
  }),
} as const;

export const generatedMediaEventClient =
  createEventClient(generatedMediaEvents);

/** Build the renderer URL that serves a generated-media file. */
export function generatedMediaUrl(fileName: string): string {
  return `orian-media://generated/${encodeURIComponent(fileName)}`;
}
