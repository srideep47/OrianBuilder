import { z } from "zod";
import {
  defineContract,
  defineEvent,
  createClient,
  createEventClient,
} from "../contracts/core";

export const SharedMediaMetaSchema = z.object({
  fileName: z.string(),
  kind: z.enum(["image", "video", "audio", "model"]),
  mimeType: z.string(),
  sizeBytes: z.number(),
  prompt: z.string().nullable(),
  thumbnail: z.string().nullable(),
});
export type SharedMediaMeta = z.infer<typeof SharedMediaMetaSchema>;

export const SharedPeerCatalogSchema = z.object({
  peerKey: z.string(),
  displayName: z.string(),
  items: z.array(SharedMediaMetaSchema),
});
export type SharedPeerCatalog = z.infer<typeof SharedPeerCatalogSchema>;

export const SharedDownloadProgressSchema = z.object({
  fileName: z.string(),
  peerKey: z.string(),
  received: z.number(),
  total: z.number(),
  status: z.enum(["downloading", "done", "error"]),
  error: z.string().nullable(),
});
export type SharedDownloadProgress = z.infer<
  typeof SharedDownloadProgressSchema
>;

export const sharedMediaContracts = {
  /** All peers' advertised shared catalogs (grouped by peer). */
  getCatalog: defineContract({
    channel: "shared-media:get-catalog",
    input: z.void(),
    output: z.array(SharedPeerCatalogSchema),
  }),
  /** Ask all connected peers to re-announce. */
  refresh: defineContract({
    channel: "shared-media:refresh",
    input: z.void(),
    output: z.object({ ok: z.boolean() }),
  }),
  /** Begin downloading a peer's file into the local library. */
  download: defineContract({
    channel: "shared-media:download",
    input: z.object({ peerKey: z.string(), fileName: z.string() }),
    output: z.object({ ok: z.boolean(), message: z.string() }),
  }),
} as const;

export const sharedMediaClient = createClient(sharedMediaContracts);

export const sharedMediaEvents = {
  catalogChanged: defineEvent({
    channel: "shared-media:catalog-changed",
    payload: z.object({ peers: z.array(SharedPeerCatalogSchema) }),
  }),
  downloadProgress: defineEvent({
    channel: "shared-media:download-progress",
    payload: SharedDownloadProgressSchema,
  }),
} as const;

export const sharedMediaEventClient = createEventClient(sharedMediaEvents);
