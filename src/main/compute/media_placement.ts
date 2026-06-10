import type { Peer } from "@/ipc/types/network";

// =============================================================================
// Orion P2P job dispatch — media placement policy (pure, unit-tested)
// =============================================================================
//
// Decides WHERE a media-generation step should run. Local-first ethos: the
// local device keeps the job unless (a) the user explicitly routed compute to
// a peer, or (b) the local GPU cannot fit the modality's model while a capable
// trusted peer can. Among capable peers, prefer one whose advertised loaded
// models already include the requested model (no swap cost there), then LAN
// over internet, then the least-busy GPU, then the lowest latency.
//
// This module is pure (peers + numbers in, decision out) so the policy is
// testable without the swarm. `media-remote.ts` wires it to live state.
// =============================================================================

/** Estimated VRAM (MB) a modality needs locally — mirrors the flow layer's
 *  CAPABILITY_MODEL_SPECS so both sides agree on what "cannot fit" means. */
export const MEDIA_VRAM_REQUIREMENTS_MB: Record<
  "image" | "audio" | "video" | "music",
  number
> = {
  image: 4096,
  audio: 2048,
  music: 8192,
  video: 8192,
};

export interface MediaPlacementInput {
  modelType: "image" | "audio" | "video" | "music";
  /** Total VRAM of the local GPU in MB (0 = no GPU detected). */
  localVramMb: number;
  /** Live peer list from the swarm. */
  peers: Peer[];
  /** Peer publicKey the user explicitly routed compute to, if any. */
  explicitPeerId?: string | null;
  /** The requester's selected model id for this modality, if any. */
  modelId?: string;
}

export interface PeerPlacement {
  peerId: string;
  label: string;
  /** Why this peer was chosen (for logs/UI). */
  reason: "explicit-target" | "local-vram-insufficient";
}

function isServingPeer(peer: Peer): boolean {
  return peer.isTrusted && peer.status === "online" && peer.computeAvailable;
}

function peerVramMb(peer: Peer): number {
  return (peer.hardware?.vramGB ?? 0) * 1024;
}

/**
 * Pick the peer a media job should run on, or null to run locally.
 */
export function pickMediaPeer(
  input: MediaPlacementInput,
): PeerPlacement | null {
  const required = MEDIA_VRAM_REQUIREMENTS_MB[input.modelType];

  // 1. Explicit routing wins: the user pointed compute at a peer.
  if (input.explicitPeerId) {
    const target = input.peers.find(
      (p) => p.publicKey === input.explicitPeerId,
    );
    if (target && isServingPeer(target)) {
      return {
        peerId: target.publicKey,
        label: `${target.displayName} · ${target.deviceName}`,
        reason: "explicit-target",
      };
    }
    // Explicit target unavailable → fall through to the automatic policy.
  }

  // 2. Local-first: keep the job here whenever the local GPU can fit it.
  if (input.localVramMb >= required) return null;

  // 3. Local can't fit → best capable trusted peer, if any.
  const candidates = input.peers.filter(
    (p) => isServingPeer(p) && peerVramMb(p) >= required,
  );
  if (candidates.length === 0) return null;

  const hasModel = (p: Peer) =>
    input.modelId != null && p.loadedModels.includes(input.modelId) ? 0 : 1;
  candidates.sort(
    (a, b) =>
      hasModel(a) - hasModel(b) ||
      Number(b.isLan) - Number(a.isLan) ||
      a.gpuUtilization - b.gpuUtilization ||
      (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity),
  );

  const best = candidates[0];
  return {
    peerId: best.publicKey,
    label: `${best.displayName} · ${best.deviceName}`,
    reason: "local-vram-insufficient",
  };
}
