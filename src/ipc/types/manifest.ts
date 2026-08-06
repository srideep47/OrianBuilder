import { z } from "zod";

// =============================================================================
// Orion Orchestrated Pipeline — Asset Manifest (the planning↔generation contract)
// =============================================================================
//
// The planning LLM (Phase A) declares EVERY asset the build needs up front: a
// deterministic target filename, a ready-to-run generation prompt, and the
// pipeline settings. The scaffolded code references those exact filenames as
// placeholders. Phase B then fills them, batched by modality, with the LLM
// unloaded. Because nothing is discovered mid-build, the orchestrator can group
// all assets of one kind together and keep exactly one pipeline resident.
//
// This file is the single source of truth for the manifest schema.
// See plans/orion-orchestrated-pipeline.md.
// =============================================================================

/** The asset modalities the pipeline batches over, in load order. */
export const AssetTypeSchema = z.enum([
  "image",
  "video",
  "music",
  "speech",
  "3d",
]);
export type AssetType = z.infer<typeof AssetTypeSchema>;

/**
 * Fixed modality processing order for Phase B. Images first so 3D refs exist;
 * speech (light/CPU-friendly TTS) before the heavier video/music pipelines.
 */
export const ASSET_TYPE_ORDER: readonly AssetType[] = [
  "image",
  "3d",
  "speech",
  "video",
  "music",
] as const;

export const AssetStatusSchema = z.enum([
  "pending", // declared, not yet generated
  "done", // generated successfully to targetFilename
  "placeholder", // generation failed; placeholder written, build not blocked
  "failed", // generation failed and no placeholder could be written
]);
export type AssetStatus = z.infer<typeof AssetStatusSchema>;

/**
 * One asset the build needs. `targetFilename` is the relative path the code
 * references (e.g. "assets/hero-banner.png"); the orchestrator writes the
 * generated file there. `refAssetId` lets a 3D asset point at an earlier image
 * to use as its reference (image group always runs before the 3D group).
 */
export const AssetSpecSchema = z.object({
  /** Stable id, unique within the manifest. Used for refAssetId links. */
  id: z.string().min(1),
  type: AssetTypeSchema,
  /** Deterministic relative path the generated file is written to. */
  targetFilename: z.string().min(1),
  /** Pre-written generation prompt. */
  prompt: z.string().min(1),
  /** Pipeline-specific config (steps, resolution, duration, seed, …). */
  settings: z.record(z.string(), z.unknown()).default({}),
  /** For type "3d": id of the image asset to use as the reference image. */
  refAssetId: z.string().optional(),
  status: AssetStatusSchema.default("pending"),
});
export type AssetSpec = z.infer<typeof AssetSpecSchema>;

/** The full set of assets a single build run needs. */
export const AssetManifestSchema = z.object({
  /** Correlates the manifest with its build run. */
  buildId: z.string().min(1),
  assets: z.array(AssetSpecSchema).default([]),
});
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

// =============================================================================
// Harmony artifact bus (P5)
// =============================================================================

/**
 * A durable output that another flow step can consume.  AssetManifest remains
 * the planning contract for generated media; FlowArtifact is the more general
 * runtime contract shared by media, Blender, Godot, code, tests and deploys.
 */
export const FlowArtifactKindSchema = z.enum([
  "image",
  "video",
  "audio",
  "music",
  "mesh",
  "scene",
  "source",
  "test-report",
  "build",
  "deployment",
  "research",
  "generic",
]);
export type FlowArtifactKind = z.infer<typeof FlowArtifactKindSchema>;

export const FlowArtifactSchema = z.object({
  /** Stable within a flow. */
  id: z.string().min(1),
  flowId: z.string().min(1),
  producerStepId: z.string().min(1),
  /** Kept as a string to avoid a manifest -> intent -> manifest import cycle. */
  capability: z.string().min(1),
  kind: FlowArtifactKindSchema,
  label: z.string().min(1),
  /** Usually an absolute file path; URLs are valid for deployments/research. */
  uri: z.string().min(1),
  mimeType: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.number(),
});
export type FlowArtifact = z.infer<typeof FlowArtifactSchema>;

/**
 * A compact reference accepted inside any capability input.  The flow runner
 * also accepts the shorthand string `artifact://<step-id>`.
 */
export const FlowArtifactRefSchema = z.object({
  $artifact: z.string().min(1),
  index: z.number().int().nonnegative().optional(),
});
export type FlowArtifactRef = z.infer<typeof FlowArtifactRefSchema>;

// =============================================================================
// Validation helpers
// =============================================================================

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Structural validation beyond the Zod shape:
 *  - asset ids are unique
 *  - targetFilenames are unique (no two assets write the same path)
 *  - every refAssetId points at an existing asset of type "image"
 *  - 3D assets may only reference images (enforces image-before-3d ordering)
 *
 * Pure function — exported for unit tests.
 */
export function validateManifest(
  manifest: AssetManifest,
): ManifestValidationResult {
  const errors: string[] = [];
  const byId = new Map<string, AssetSpec>();

  for (const asset of manifest.assets) {
    if (byId.has(asset.id)) {
      errors.push(`duplicate asset id "${asset.id}"`);
    }
    byId.set(asset.id, asset);
  }

  const seenFiles = new Map<string, string>();
  for (const asset of manifest.assets) {
    const existing = seenFiles.get(asset.targetFilename);
    if (existing) {
      errors.push(
        `duplicate targetFilename "${asset.targetFilename}" (assets "${existing}" and "${asset.id}")`,
      );
    }
    seenFiles.set(asset.targetFilename, asset.id);
  }

  for (const asset of manifest.assets) {
    if (asset.refAssetId == null) continue;
    const ref = byId.get(asset.refAssetId);
    if (!ref) {
      errors.push(
        `asset "${asset.id}" references unknown asset "${asset.refAssetId}"`,
      );
      continue;
    }
    if (ref.type !== "image") {
      errors.push(
        `asset "${asset.id}" references "${asset.refAssetId}" of type "${ref.type}"; refs must be images`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Group assets by modality and return them in the fixed Phase-B processing
 * order (image → 3d → video → music), skipping empty groups. Within a group
 * the original manifest order is preserved.
 *
 * Pure function — exported for unit tests.
 */
export function groupAssetsByModality(
  manifest: AssetManifest,
): { type: AssetType; assets: AssetSpec[] }[] {
  return ASSET_TYPE_ORDER.map((type) => ({
    type,
    assets: manifest.assets.filter((a) => a.type === type),
  })).filter((group) => group.assets.length > 0);
}
