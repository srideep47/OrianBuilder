import { describe, expect, it } from "vitest";
import { pickMediaPeer } from "./media_placement";
import type { Peer } from "@/ipc/types/network";

function makePeer(overrides: Partial<Peer>): Peer {
  return {
    publicKey: "peer-key",
    fingerprint: "fp",
    displayName: "Teammate",
    deviceName: "desktop",
    deviceType: "desktop",
    hardware: { cpu: "cpu", ramGB: 64, gpu: "rtx", vramGB: 16 },
    status: "online",
    isTrusted: true,
    isLan: true,
    latencyMs: 5,
    lastSeenAt: Date.now(),
    lastLoadUpdateAt: Date.now(),
    loadedModels: [],
    gpuUtilization: 0,
    computeAvailable: true,
    appVersion: "1.0.0",
    ...overrides,
  };
}

describe("pickMediaPeer", () => {
  it("keeps the job local when the local GPU can fit the model", () => {
    const placement = pickMediaPeer({
      modelType: "image",
      localVramMb: 16384,
      peers: [makePeer({})],
    });
    expect(placement).toBeNull();
  });

  it("offloads to a capable trusted peer when local VRAM cannot fit", () => {
    const placement = pickMediaPeer({
      modelType: "video", // needs 8192 MB
      localVramMb: 4096,
      peers: [makePeer({ publicKey: "big-peer" })],
    });
    expect(placement).toMatchObject({
      peerId: "big-peer",
      reason: "local-vram-insufficient",
    });
  });

  it("returns null when no peer is capable either", () => {
    const placement = pickMediaPeer({
      modelType: "video",
      localVramMb: 4096,
      peers: [
        makePeer({ hardware: { cpu: "c", ramGB: 8, gpu: "g", vramGB: 4 } }),
        makePeer({ publicKey: "off", status: "offline" }),
        makePeer({ publicKey: "untrusted", isTrusted: false }),
        makePeer({ publicKey: "not-sharing", computeAvailable: false }),
      ],
    });
    expect(placement).toBeNull();
  });

  it("honors an explicit compute target even when local could handle it", () => {
    const placement = pickMediaPeer({
      modelType: "image",
      localVramMb: 16384,
      peers: [makePeer({ publicKey: "chosen" })],
      explicitPeerId: "chosen",
    });
    expect(placement).toMatchObject({
      peerId: "chosen",
      reason: "explicit-target",
    });
  });

  it("falls back to the automatic policy when the explicit target is unavailable", () => {
    const placement = pickMediaPeer({
      modelType: "image",
      localVramMb: 16384,
      peers: [makePeer({ publicKey: "chosen", status: "offline" })],
      explicitPeerId: "chosen",
    });
    expect(placement).toBeNull(); // local can fit → stays local
  });

  it("prefers model-resident, then LAN, then least-busy peers", () => {
    const placement = pickMediaPeer({
      modelType: "video",
      localVramMb: 0,
      modelId: "wan-2.2",
      peers: [
        makePeer({
          publicKey: "lan-idle",
          isLan: true,
          gpuUtilization: 5,
        }),
        makePeer({
          publicKey: "wan-busy-but-resident",
          isLan: false,
          gpuUtilization: 80,
          loadedModels: ["wan-2.2"],
        }),
      ],
    });
    expect(placement?.peerId).toBe("wan-busy-but-resident");

    const noResident = pickMediaPeer({
      modelType: "video",
      localVramMb: 0,
      peers: [
        makePeer({ publicKey: "internet", isLan: false, gpuUtilization: 0 }),
        makePeer({ publicKey: "lan", isLan: true, gpuUtilization: 50 }),
      ],
    });
    expect(noResident?.peerId).toBe("lan");
  });
});
