/**
 * Compute routing state — tracks which device (local or peer) handles inference.
 */

import { networkSwarm } from "@/main/network/swarm";
import type { Peer } from "@/ipc/types/network";

export type ComputeMode = "auto" | "local" | "peer";

export interface ComputeTarget {
  mode: ComputeMode;
  /** set when mode === "peer" */
  peerId?: string;
}

export interface ComputeNode {
  id: string; // "local" or peer publicKey
  label: string;
  isLocal: boolean;
  gpuUtilization: number;
  loadedModels: string[];
  computeAvailable: boolean;
  latencyMs: number | null;
  hardware: Peer["hardware"] | null;
}

let _target: ComputeTarget = { mode: "local" };

export function getComputeTarget(): ComputeTarget {
  return { ..._target };
}

export function setComputeTarget(target: ComputeTarget): void {
  _target = { ...target };
}

export function getAvailableNodes(
  selfHardware: Peer["hardware"] | null,
): ComputeNode[] {
  const nodes: ComputeNode[] = [
    {
      id: "local",
      label: "This Device",
      isLocal: true,
      gpuUtilization: 0,
      loadedModels: [],
      computeAvailable: true,
      latencyMs: null,
      hardware: selfHardware,
    },
  ];

  const { peers } = networkSwarm.getStatus();
  for (const peer of peers) {
    if (peer.status !== "online" || !peer.isTrusted) continue;
    nodes.push({
      id: peer.publicKey,
      label: `${peer.displayName} · ${peer.deviceName}`,
      isLocal: false,
      gpuUtilization: peer.gpuUtilization,
      loadedModels: peer.loadedModels,
      computeAvailable: peer.computeAvailable,
      latencyMs: peer.latencyMs,
      hardware: peer.hardware,
    });
  }

  return nodes;
}

/** Auto-select the best available node. Returns "local" if no peers qualify. */
export function autoSelectBestNode(): ComputeNode | null {
  const { peers } = networkSwarm.getStatus();
  const candidates = peers.filter(
    (p) => p.status === "online" && p.isTrusted && p.computeAvailable,
  );
  if (!candidates.length) return null;

  // Score: (100 - gpuUtil) - latencyPenalty
  const scored = candidates.map((p) => ({
    peer: p,
    score: 100 - p.gpuUtilization - (p.latencyMs ?? 50) / 10,
  }));
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0].peer;
  return {
    id: best.publicKey,
    label: `${best.displayName} · ${best.deviceName}`,
    isLocal: false,
    gpuUtilization: best.gpuUtilization,
    loadedModels: best.loadedModels,
    computeAvailable: best.computeAvailable,
    latencyMs: best.latencyMs,
    hardware: best.hardware,
  };
}

/** Returns the node to actually use for the next inference call. */
export function resolveActiveNode(
  selfHardware: Peer["hardware"] | null,
): ComputeNode {
  const nodes = getAvailableNodes(selfHardware);
  const local = nodes[0];

  if (_target.mode === "local") return local;

  if (_target.mode === "peer" && _target.peerId) {
    const found = nodes.find((n) => n.id === _target.peerId);
    if (found?.computeAvailable) return found;
  }

  if (_target.mode === "auto") {
    const best = autoSelectBestNode();
    if (best) return best;
  }

  return local;
}
