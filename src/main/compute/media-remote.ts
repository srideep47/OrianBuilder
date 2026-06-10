/**
 * Media Remote — the "client" side of distributed media generation.
 *
 * `maybeGenerateMediaOnPeer` is the hook the flow capability layer calls before
 * generating locally: the placement policy (media_placement.ts) decides whether
 * a trusted peer should run the job; if so, the request is dispatched over the
 * P2P channel and the returned file is written to the caller's outputPath.
 *
 * Returning `null` means "no peer applies — run locally". A failed remote run
 * resolves with success:false so the caller can fall back to its local chain.
 */

import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import log from "electron-log";
import { networkSwarm } from "@/main/network/swarm";
import { getComputeTarget } from "@/main/compute/routing";
import { getCachedHardwareProfile } from "@/main/hardware/detect";
import { pickMediaPeer, type PeerPlacement } from "./media_placement";
import type {
  MediaGenerationRequest,
  MediaGenerationResult,
} from "@/main/ipc/utils/model_orchestrator";

const logger = log.scope("compute:media-remote");

/** Per-modality remote-job timeout: media generation is legitimately slow. */
const TIMEOUT_MS: Record<string, number> = {
  image: 5 * 60_000,
  audio: 10 * 60_000,
  music: 15 * 60_000,
  video: 30 * 60_000,
};

/** Resolve where this media request should run; null = locally. */
export async function chooseMediaPeer(
  request: MediaGenerationRequest,
): Promise<PeerPlacement | null> {
  if (request.modelType === "transcribe") return null;
  let localVramMb = 0;
  try {
    const profile = await getCachedHardwareProfile();
    localVramMb = profile?.primaryGpu?.vramMb ?? 0;
  } catch {
    // Unknown local hardware → treat as capable (local-first; don't offload blind).
    return null;
  }
  const target = getComputeTarget();
  return pickMediaPeer({
    modelType: request.modelType,
    localVramMb,
    peers: networkSwarm.getStatus().peers,
    explicitPeerId: target.mode === "peer" ? (target.peerId ?? null) : null,
    modelId: request.modelId,
  });
}

/** Run one media request on a specific peer, writing the result to
 *  `request.outputPath`. Resolves success:false on any failure (never throws). */
export function generateMediaOnPeer(
  placement: PeerPlacement,
  request: MediaGenerationRequest,
): Promise<MediaGenerationResult> {
  return new Promise((resolve) => {
    if (request.modelType === "transcribe") {
      resolve({
        success: false,
        outputPath: request.outputPath,
        durationMs: 0,
        error: "transcribe jobs are not remoted",
      });
      return;
    }
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const shortId = requestId.slice(0, 8);
    const chunks: Buffer[] = [];
    let settled = false;

    const settle = (result: MediaGenerationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const fail = (error: string) => {
      logger.warn(`[remote ${shortId}] ${error}`);
      settle({
        success: false,
        outputPath: request.outputPath,
        durationMs: Date.now() - startedAt,
        error,
      });
    };

    const timeoutMs = TIMEOUT_MS[request.modelType] ?? 10 * 60_000;
    const timer = setTimeout(() => {
      cleanup?.();
      fail(
        `remote ${request.modelType} generation timed out after ${timeoutMs} ms`,
      );
    }, timeoutMs);
    timer.unref?.();

    logger.info(
      `[remote ${shortId}] dispatching ${request.modelType} to ${placement.label} (${placement.reason})`,
    );

    const cleanup = networkSwarm.sendMediaGenRequest(
      placement.peerId,
      {
        type: "MEDIA_GEN_REQUEST",
        requestId,
        modelType: request.modelType,
        prompt: request.prompt,
        modelId: request.modelId,
        options: request.options,
        ext: path.extname(request.outputPath).replace(".", "") || "bin",
      },
      (data, _eof) => {
        if (data) chunks.push(Buffer.from(data, "base64"));
      },
      (err) => {
        if (err) {
          fail(err);
          return;
        }
        void (async () => {
          try {
            const bytes = Buffer.concat(chunks);
            if (bytes.length === 0) {
              fail("peer sent no data for the generated asset");
              return;
            }
            await fs.mkdir(path.dirname(request.outputPath), {
              recursive: true,
            });
            await fs.writeFile(request.outputPath, bytes);
            logger.info(
              `[remote ${shortId}] received ${bytes.length} bytes -> ${request.outputPath} (${Date.now() - startedAt} ms)`,
            );
            settle({
              success: true,
              outputPath: request.outputPath,
              durationMs: Date.now() - startedAt,
            });
          } catch (writeErr) {
            fail(
              writeErr instanceof Error ? writeErr.message : String(writeErr),
            );
          }
        })();
      },
    );
  });
}

/**
 * The flow-layer hook: decide placement and, when a peer applies, run the job
 * there. Returns null when the job should run locally; returns success:false
 * when a chosen peer failed (caller falls back to its local chain).
 */
export async function maybeGenerateMediaOnPeer(
  request: MediaGenerationRequest,
): Promise<MediaGenerationResult | null> {
  let placement: PeerPlacement | null = null;
  try {
    placement = await chooseMediaPeer(request);
  } catch (err) {
    logger.warn("media placement failed; running locally", err);
    return null;
  }
  if (!placement) return null;
  return generateMediaOnPeer(placement, request);
}
