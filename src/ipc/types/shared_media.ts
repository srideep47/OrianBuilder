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

/**
 * An inbound asset a peer wants to send us, awaiting the user's answer.
 *
 * OrionAndroid added this flow to its P2P bridge and its own commit noted there
 * was no desktop counterpart. This is that counterpart, message-for-message.
 */
export const PushOfferSchema = z.object({
  requestId: z.string(),
  peerKey: z.string(),
  displayName: z.string(),
  fileName: z.string(),
  sizeBytes: z.number(),
  mimeType: z.string().nullable().optional(),
});
export type SharedPushOffer = z.infer<typeof PushOfferSchema>;

export const PushResultSchema = z.object({
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().nullable().optional(),
});
export type SharedPushResult = z.infer<typeof PushResultSchema>;

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
  /**
   * Offer one local file to a trusted peer. Nothing transfers until they accept.
   *
   * The counterpart to `download`: there, we ask for something a peer announced.
   * Here we push something they never asked for, which is why it needs their
   * explicit accept rather than just our trust in them.
   */
  pushAsset: defineContract({
    channel: "shared-media:push-asset",
    input: z.object({
      peerKey: z.string(),
      absolutePath: z.string(),
      fileName: z.string().optional(),
      mimeType: z.string().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      requestId: z.string().optional(),
      message: z.string().optional(),
    }),
  }),
  /** Accept or decline an inbound offer. */
  respondToPush: defineContract({
    channel: "shared-media:respond-to-push",
    input: z.object({
      requestId: z.string(),
      accept: z.boolean(),
      reason: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),
  /** Offers still awaiting an answer, so a reopened UI can show them. */
  pendingPushOffers: defineContract({
    channel: "shared-media:pending-push-offers",
    input: z.void(),
    output: z.array(PushOfferSchema),
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
  pushOffer: defineEvent({
    channel: "shared-media:push-offer",
    payload: PushOfferSchema,
  }),
  pushResult: defineEvent({
    channel: "shared-media:push-result",
    payload: PushResultSchema,
  }),
} as const;

export const sharedMediaEventClient = createEventClient(sharedMediaEvents);
