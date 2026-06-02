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
} as const;

export const generatedMediaClient = createClient(generatedMediaContracts);

export const generatedMediaEvents = {
  changed: defineEvent({
    channel: "generated-media:changed",
    payload: z.object({ count: z.number() }),
  }),
} as const;

export const generatedMediaEventClient = createEventClient(generatedMediaEvents);

/** Build the renderer URL that serves a generated-media file. */
export function generatedMediaUrl(fileName: string): string {
  return `orian-media://generated/${encodeURIComponent(fileName)}`;
}
