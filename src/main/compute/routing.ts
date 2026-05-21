/**
 * Compute routing state — tracks which device (local or peer) handles inference.
 */

import { networkSwarm } from "@/main/network/swarm";
import { listTrustedPeers } from "@/main/network/friends";
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
  const livePeerKeys = new Set<string>();

  // 1. Trusted peers currently online & sharing compute → first-class nodes.
  // 2. Trusted peers we can SEE but who haven't enabled "Share my compute" yet
  //    → still show them with computeAvailable=false so they don't flicker out
  //    of the picker while waiting for a LOAD_UPDATE that flips the flag.
  for (const peer of peers) {
    if (!peer.isTrusted) continue;
    livePeerKeys.add(peer.publicKey);
    const suffix = peer.isLan ? " · LAN" : "";
    nodes.push({
      id: peer.publicKey,
      label: `${peer.displayName} · ${peer.deviceName}${suffix}`,
      isLocal: false,
      gpuUtilization: peer.gpuUtilization,
      loadedModels: peer.loadedModels,
      computeAvailable: peer.status === "online" && peer.computeAvailable,
      latencyMs: peer.latencyMs,
      hardware: peer.hardware,
    });
  }

  // 3. Trusted peers we know about but haven't connected to in this session
  //    → show as disabled placeholders so the user still sees them in the list
  //    and isn't confused when they briefly drop off and reconnect.
  for (const trusted of listTrustedPeers()) {
    if (livePeerKeys.has(trusted.publicKey)) continue;
    nodes.push({
      id: trusted.publicKey,
      label: `${trusted.displayName} · (offline)`,
      isLocal: false,
      gpuUtilization: 0,
      loadedModels: [],
      computeAvailable: false,
      latencyMs: null,
      hardware: null,
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
