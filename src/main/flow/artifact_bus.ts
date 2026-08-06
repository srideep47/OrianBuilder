import path from "node:path";

import type { FlowArtifact, FlowArtifactKind } from "@/ipc/types/manifest";
import type { CapabilityId } from "@/ipc/types/intent";

const PATH_KEY = /(?:path|file|artifact|output)$/i;
const URL_KEY = /(?:url|uri)$/i;

function inferKind(uri: string): FlowArtifactKind {
  const clean = uri.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  const ext = path.extname(clean);
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext))
    return "image";
  if ([".mp4", ".webm", ".mov", ".mkv"].includes(ext)) return "video";
  if ([".wav", ".mp3", ".flac", ".ogg", ".m4a"].includes(ext)) return "audio";
  if ([".glb", ".gltf", ".fbx", ".obj", ".blend"].includes(ext)) return "mesh";
  if ([".tscn", ".scn", ".godot"].includes(ext)) return "scene";
  if ([".exe", ".msi", ".apk", ".appimage", ".zip"].includes(ext))
    return "build";
  if (
    [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".py",
      ".gd",
      ".rs",
      ".go",
      ".java",
      ".kt",
    ].includes(ext)
  )
    return "source";
  if (/^https?:\/\//i.test(uri)) return "deployment";
  return "generic";
}

function explicitArtifacts(
  output: Record<string, unknown>,
): Array<{ uri: string; label?: string; kind?: FlowArtifactKind }> {
  if (!Array.isArray(output.artifacts)) return [];
  return output.artifacts.flatMap((item) => {
    if (typeof item === "string") return [{ uri: item }];
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const uri = record.uri ?? record.path ?? record.outputPath;
    if (typeof uri !== "string" || !uri.trim()) return [];
    return [
      {
        uri,
        label: typeof record.label === "string" ? record.label : undefined,
        kind:
          typeof record.kind === "string"
            ? (record.kind as FlowArtifactKind)
            : undefined,
      },
    ];
  });
}

/**
 * In-memory view of a flow's durable artifacts.  The runner persists `list()`
 * beside every checkpoint, so a resumed run reconstructs exactly the same bus.
 */
export class FlowArtifactBus {
  private readonly artifacts = new Map<string, FlowArtifact>();

  constructor(
    readonly flowId: string,
    seed: FlowArtifact[] = [],
  ) {
    for (const artifact of seed) this.artifacts.set(artifact.id, artifact);
  }

  list(): FlowArtifact[] {
    return [...this.artifacts.values()];
  }

  fromStep(stepId: string): FlowArtifact[] {
    return this.list().filter((item) => item.producerStepId === stepId);
  }

  /** Publish explicit artifact descriptors plus conventional path/url outputs. */
  publish(
    stepId: string,
    capability: CapabilityId,
    output: Record<string, unknown>,
  ): FlowArtifact[] {
    const candidates = explicitArtifacts(output);
    for (const [key, value] of Object.entries(output)) {
      if (typeof value === "string" && value.trim()) {
        if (PATH_KEY.test(key) || URL_KEY.test(key)) {
          candidates.push({ uri: value, label: key });
        }
      } else if (
        Array.isArray(value) &&
        (PATH_KEY.test(key) || /paths|files|urls|artifacts/i.test(key))
      ) {
        for (const item of value) {
          if (typeof item === "string" && item.trim()) {
            candidates.push({ uri: item, label: key });
          }
        }
      }
    }

    const published: FlowArtifact[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const uri = candidate.uri.trim();
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      const index = this.fromStep(stepId).length;
      const artifact: FlowArtifact = {
        id: `${stepId}:${index}`,
        flowId: this.flowId,
        producerStepId: stepId,
        capability,
        kind: candidate.kind ?? inferKind(uri),
        label:
          candidate.label ?? (path.basename(uri) || `${capability} output`),
        uri,
        metadata: {},
        createdAt: Date.now(),
      };
      this.artifacts.set(artifact.id, artifact);
      published.push(artifact);
    }
    return published;
  }

  resolve(ref: string, index = 0): string {
    const direct = this.artifacts.get(ref);
    if (direct) return direct.uri;
    const byStep = this.fromStep(ref);
    const artifact = byStep[index];
    if (!artifact) {
      throw new Error(
        `Artifact reference "${ref}" did not resolve in this flow.`,
      );
    }
    return artifact.uri;
  }

  /** Resolve references recursively without mutating the parsed intent. */
  resolveInput(value: unknown): unknown {
    if (typeof value === "string" && value.startsWith("artifact://")) {
      const ref = value.slice("artifact://".length);
      return this.resolve(ref);
    }
    if (Array.isArray(value))
      return value.map((item) => this.resolveInput(item));
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (typeof record.$artifact === "string") {
      return this.resolve(
        record.$artifact,
        typeof record.index === "number" ? record.index : 0,
      );
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        this.resolveInput(item),
      ]),
    );
  }
}
