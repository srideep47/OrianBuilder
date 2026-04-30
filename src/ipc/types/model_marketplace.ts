import { z } from "zod";
import {
  defineContract,
  defineEvent,
  createClient,
  createEventClient,
} from "../contracts/core";

// ─── Schemas ────────────────────────────────────────────────────────────────

export const HFSearchModelSchema = z.object({
  id: z.string(),
  author: z.string().nullable(),
  downloads: z.number(),
  likes: z.number(),
  trending_score: z.number().optional(),
  tags: z.array(z.string()),
  pipeline_tag: z.string().optional(),
  library_name: z.string().optional(),
  lastModified: z.string().optional(),
  gated: z.union([z.boolean(), z.string()]).optional(),
  private: z.boolean().optional(),
});
export type HFSearchModel = z.infer<typeof HFSearchModelSchema>;

export const HFFileSiblingSchema = z.object({
  rfilename: z.string(),
  size: z.number().optional(),
  lfs: z
    .object({ size: z.number().optional(), oid: z.string().optional() })
    .optional(),
});
export type HFFileSibling = z.infer<typeof HFFileSiblingSchema>;

export const HFModelDetailSchema = z.object({
  id: z.string(),
  author: z.string().nullable(),
  cardData: z.record(z.string(), z.unknown()).optional(),
  description: z.string().optional(),
  siblings: z.array(HFFileSiblingSchema),
  tags: z.array(z.string()),
  downloads: z.number(),
  likes: z.number(),
  pipeline_tag: z.string().optional(),
  library_name: z.string().optional(),
  lastModified: z.string().optional(),
  gated: z.union([z.boolean(), z.string()]).optional(),
  private: z.boolean().optional(),
});
export type HFModelDetail = z.infer<typeof HFModelDetailSchema>;

export const SearchModelsParamsSchema = z.object({
  query: z.string().optional(),
  ggufOnly: z.boolean().optional(),
  author: z.string().optional(),
  sort: z.enum(["downloads", "likes", "trending", "lastModified"]).optional(),
  limit: z.number().optional(),
});

export const ModelDetailParamsSchema = z.object({
  repoId: z.string(),
});

// ─── Downloads ───────────────────────────────────────────────────────────────

export const DownloadStateSchema = z.enum([
  "queued",
  "downloading",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export const DownloadProgressSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  fileName: z.string(),
  totalBytes: z.number(),
  receivedBytes: z.number(),
  bytesPerSecond: z.number(),
  state: DownloadStateSchema,
  error: z.string().optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  destPath: z.string(),
});
export type DownloadProgress = z.infer<typeof DownloadProgressSchema>;

export const StartDownloadParamsSchema = z.object({
  repoId: z.string(),
  fileName: z.string(),
  parallelConnections: z.number().optional(),
});

export const StartDownloadResultSchema = z.object({
  success: z.boolean(),
  download: DownloadProgressSchema.optional(),
  error: z.string().optional(),
});

// ─── Local library ───────────────────────────────────────────────────────────

export const LocalModelEntrySchema = z.object({
  filePath: z.string(),
  fileName: z.string(),
  fileSizeBytes: z.number(),
  modifiedAt: z.number(),
  repoId: z.string().nullable(),
});
export type LocalModelEntry = z.infer<typeof LocalModelEntrySchema>;

export const ModelsDirInfoSchema = z.object({
  dir: z.string(),
  totalBytes: z.number(),
  freeBytes: z.number(),
});

// ─── GGUF metadata ───────────────────────────────────────────────────────────

export const GgufMetadataSchema = z.object({
  architecture: z.string().nullable(),
  name: z.string().nullable(),
  contextLength: z.number().nullable(),
  blockCount: z.number().nullable(),
  embeddingLength: z.number().nullable(),
  feedForwardLength: z.number().nullable(),
  attentionHeadCount: z.number().nullable(),
  attentionHeadCountKv: z.number().nullable(),
  vocabSize: z.number().nullable(),
  fileType: z.number().nullable(),
  quantization: z.string().nullable(),
  ropeFreqBase: z.number().nullable(),
  ropeDimensionCount: z.number().nullable(),
  tensorCount: z.number(),
  metadataKeyValueCount: z.number(),
});
export type GgufMetadata = z.infer<typeof GgufMetadataSchema>;

// ─── Contracts ───────────────────────────────────────────────────────────────

export const modelMarketplaceContracts = {
  searchModels: defineContract({
    channel: "marketplace:search-models",
    input: SearchModelsParamsSchema,
    output: z.array(HFSearchModelSchema),
  }),

  getModelDetail: defineContract({
    channel: "marketplace:get-model-detail",
    input: ModelDetailParamsSchema,
    output: HFModelDetailSchema,
  }),

  startDownload: defineContract({
    channel: "marketplace:start-download",
    input: StartDownloadParamsSchema,
    output: StartDownloadResultSchema,
  }),

  cancelDownload: defineContract({
    channel: "marketplace:cancel-download",
    input: z.object({ id: z.string() }),
    output: z.object({ success: z.boolean() }),
  }),

  listDownloads: defineContract({
    channel: "marketplace:list-downloads",
    input: z.void(),
    output: z.array(DownloadProgressSchema),
  }),

  clearCompletedDownloads: defineContract({
    channel: "marketplace:clear-completed-downloads",
    input: z.void(),
    output: z.object({ removed: z.number() }),
  }),

  listLocalModels: defineContract({
    channel: "marketplace:list-local-models",
    input: z.void(),
    output: z.array(LocalModelEntrySchema),
  }),

  deleteLocalModel: defineContract({
    channel: "marketplace:delete-local-model",
    input: z.object({ filePath: z.string() }),
    output: z.object({ success: z.boolean(), error: z.string().optional() }),
  }),

  getModelsDirInfo: defineContract({
    channel: "marketplace:get-dir-info",
    input: z.void(),
    output: ModelsDirInfoSchema,
  }),

  readGgufMetadata: defineContract({
    channel: "marketplace:read-gguf-metadata",
    input: z.object({ filePath: z.string() }),
    output: GgufMetadataSchema,
  }),
} as const;

// ─── Events ──────────────────────────────────────────────────────────────────

export const modelMarketplaceEvents = {
  downloadProgress: defineEvent({
    channel: "marketplace:download-progress",
    payload: DownloadProgressSchema,
  }),
} as const;

export const modelMarketplaceClient = createClient(modelMarketplaceContracts);
export const modelMarketplaceEventClient = createEventClient(
  modelMarketplaceEvents,
);
