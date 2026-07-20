import { z } from "zod";
import type { AssetManifest, AssetType } from "@/ipc/types/manifest";

/**
 * Orion's executor-neutral media graph. The UI, agent planner, local workers,
 * network peers, and adapters such as ComfyUI should exchange this contract
 * instead of inventing endpoint-specific request shapes.
 */
export const MediaNodeOperationSchema = z.enum([
  "generate.image",
  "generate.video",
  "generate.music",
  "generate.speech",
  "generate.3d",
  "condition.control",
  "preprocess.depth",
  "preprocess.pose",
  "image.inpaint",
  "image.upscale",
  "video.interpolate",
  "video.concat",
  "audio.mix",
  "quality.evaluate",
  "artifact.export",
]);
export type MediaNodeOperation = z.infer<typeof MediaNodeOperationSchema>;

export const MediaInputRefSchema = z.object({
  nodeId: z.string().min(1),
  output: z.string().min(1).default("artifact"),
});
export type MediaInputRef = z.infer<typeof MediaInputRefSchema>;

export const MediaResidencySchema = z.object({
  kind: z.enum(["llm", "image", "video", "music", "speech", "3d"]),
  modelId: z.string().min(1),
  vramMb: z.number().int().nonnegative().optional(),
  precision: z.string().min(1).optional(),
});

export const MediaGraphNodeSchema = z.object({
  id: z.string().min(1),
  operation: MediaNodeOperationSchema,
  inputs: z.record(z.string(), MediaInputRefSchema).default({}),
  parameters: z.record(z.string(), z.unknown()).default({}),
  outputs: z.array(z.string().min(1)).min(1).default(["artifact"]),
  targetFilename: z.string().min(1).optional(),
  residency: MediaResidencySchema.optional(),
  cacheable: z.boolean().default(true),
});
export type MediaGraphNode = z.infer<typeof MediaGraphNodeSchema>;

export const OrionMediaGraphSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  nodes: z.array(MediaGraphNodeSchema),
  outputs: z.record(z.string(), MediaInputRefSchema).default({}),
  execution: z
    .object({
      placement: z
        .enum(["local-only", "local-first", "peer-first", "api-first"])
        .default("local-first"),
      allowPaidFallback: z.boolean().default(false),
    })
    .default({ placement: "local-first", allowPaidFallback: false }),
});
export type OrionMediaGraph = z.infer<typeof OrionMediaGraphSchema>;

export interface MediaGraphValidationResult {
  ok: boolean;
  errors: string[];
}

export interface CompiledMediaGraph extends MediaGraphValidationResult {
  /** Stable dependency order. Nodes with equal priority retain source order. */
  orderedNodeIds: string[];
  /** Dependency waves that may be scheduled concurrently when resources fit. */
  waves: string[][];
}

function isUnsafeTarget(target: string): boolean {
  const normalized = target.replace(/\\/g, "/");
  return (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  );
}

/** Validate graph links, outputs, paths, and acyclicity. */
export function validateMediaGraph(
  graph: OrionMediaGraph,
): MediaGraphValidationResult {
  const errors: string[] = [];
  const byId = new Map<string, MediaGraphNode>();
  const targets = new Map<string, string>();

  for (const node of graph.nodes) {
    if (byId.has(node.id)) errors.push(`duplicate node id "${node.id}"`);
    byId.set(node.id, node);
    if (node.targetFilename) {
      if (isUnsafeTarget(node.targetFilename)) {
        errors.push(`node "${node.id}" has unsafe targetFilename`);
      }
      const previous = targets.get(node.targetFilename);
      if (previous) {
        errors.push(
          `duplicate targetFilename "${node.targetFilename}" (nodes "${previous}" and "${node.id}")`,
        );
      }
      targets.set(node.targetFilename, node.id);
    }
  }

  const checkRef = (owner: string, ref: MediaInputRef) => {
    const source = byId.get(ref.nodeId);
    if (!source) {
      errors.push(`"${owner}" references unknown node "${ref.nodeId}"`);
    } else if (!source.outputs.includes(ref.output)) {
      errors.push(
        `"${owner}" references unknown output "${ref.output}" on node "${ref.nodeId}"`,
      );
    }
  };
  for (const node of graph.nodes) {
    for (const ref of Object.values(node.inputs)) checkRef(node.id, ref);
  }
  for (const [name, ref] of Object.entries(graph.outputs)) {
    checkRef(`graph output ${name}`, ref);
  }

  const compiled = compileWaves(graph);
  if (compiled.orderedNodeIds.length !== byId.size) {
    errors.push("media graph contains a dependency cycle");
  }
  return { ok: errors.length === 0, errors };
}

function compileWaves(
  graph: OrionMediaGraph,
): Pick<CompiledMediaGraph, "orderedNodeIds" | "waves"> {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const index = new Map(graph.nodes.map((node, order) => [node.id, order]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of graph.nodes) {
    const dependencies = new Set(
      Object.values(node.inputs)
        .map((ref) => ref.nodeId)
        .filter((id) => ids.has(id)),
    );
    indegree.set(node.id, dependencies.size);
    for (const dependency of dependencies) {
      const next = dependents.get(dependency) ?? [];
      next.push(node.id);
      dependents.set(dependency, next);
    }
  }

  let ready = graph.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id);
  const waves: string[][] = [];
  const orderedNodeIds: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
    const wave = ready;
    waves.push(wave);
    orderedNodeIds.push(...wave);
    const nextReady: string[] = [];
    for (const id of wave) {
      for (const dependent of dependents.get(id) ?? []) {
        const remaining = (indegree.get(dependent) ?? 1) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) nextReady.push(dependent);
      }
    }
    ready = nextReady;
  }
  return { orderedNodeIds, waves };
}

/** Compile a validated graph into deterministic dependency waves. */
export function compileMediaGraph(graph: OrionMediaGraph): CompiledMediaGraph {
  const validation = validateMediaGraph(graph);
  const compiled = compileWaves(graph);
  return { ...validation, ...compiled };
}

function generationOperation(type: AssetType): MediaNodeOperation {
  return `generate.${type}` as MediaNodeOperation;
}

/** Compatibility compiler for today's planner manifest. This makes existing
 * flows graph-native without forcing an all-at-once backend rewrite. */
export function mediaGraphFromAssetManifest(
  manifest: AssetManifest,
): OrionMediaGraph {
  const nodes: MediaGraphNode[] = manifest.assets.map((asset) => {
    const inputs: Record<string, MediaInputRef> = {};
    if (asset.refAssetId) {
      inputs.reference = {
        nodeId: asset.refAssetId,
        output: "artifact",
      };
    }
    return {
      id: asset.id,
      operation: generationOperation(asset.type),
      inputs,
      parameters: { prompt: asset.prompt, ...asset.settings },
      outputs: ["artifact"],
      targetFilename: asset.targetFilename,
      cacheable: true,
    };
  });
  return OrionMediaGraphSchema.parse({
    version: 1,
    id: manifest.buildId,
    nodes,
    outputs: Object.fromEntries(
      nodes.map((node) => [node.id, { nodeId: node.id, output: "artifact" }]),
    ),
    execution: { placement: "local-first", allowPaidFallback: false },
  });
}
