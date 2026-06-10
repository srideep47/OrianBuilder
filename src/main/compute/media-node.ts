/**
 * Media Compute Node — the "server" side of distributed media generation.
 *
 * When a trusted peer dispatches a MEDIA_GEN_REQUEST to this device (after the
 * trust check in swarm.ts), this module runs the request through the local
 * media dispatcher — the same tiered local/cloud path Orion flows use — and
 * streams the resulting file back as base64 MEDIA_GEN_CHUNK messages.
 *
 * A placeholder result (no real provider produced output) is reported as an
 * error rather than streamed: the requester has its own local fallback chain
 * and should use it instead of receiving a blank asset.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import log from "electron-log";
import type { PeerChannel, ChannelMessage } from "@/main/network/peer-channel";
import {
  initMediaDispatcher,
  dispatchMediaGeneration,
} from "@/main/ipc/utils/media_dispatcher";

const logger = log.scope("compute:media-node");

/** Base64 expands ~4/3; 48 KiB raw keeps each framed message well under 64 KiB. */
const CHUNK_BYTES = 48 * 1024;

/** Concurrent remote jobs cap, so peers can't saturate this device's GPU. */
const MAX_CONCURRENT_JOBS = 1;
let activeJobs = 0;

export function getActiveMediaJobCount(): number {
  return activeJobs;
}

type MediaGenRequestMessage = Extract<
  ChannelMessage,
  { type: "MEDIA_GEN_REQUEST" }
>;

/** Called by swarm.ts when a MEDIA_GEN_REQUEST arrives from a trusted peer. */
export async function handleMediaGenerationRequest(
  channel: PeerChannel,
  msg: MediaGenRequestMessage,
): Promise<void> {
  const shortId = msg.requestId.slice(0, 8);
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    logger.warn(
      `[media ${shortId}] rejected: ${activeJobs} job(s) already running`,
    );
    channel.send({
      type: "MEDIA_GEN_ERROR",
      requestId: msg.requestId,
      error: "Peer is busy with another media job — try again shortly.",
    });
    return;
  }

  activeJobs += 1;
  const tmpDir = path.join(os.tmpdir(), "orion-remote-media");
  const ext = msg.ext.replace(/[^a-z0-9]/gi, "") || "bin";
  const outputPath = path.join(
    tmpDir,
    `remote-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${ext}`,
  );

  logger.info(
    `[media ${shortId}] generating ${msg.modelType} for peer` +
      (msg.modelId ? ` (model=${msg.modelId})` : ""),
  );

  try {
    await fs.mkdir(tmpDir, { recursive: true });
    initMediaDispatcher();
    const result = await dispatchMediaGeneration({
      modelType: msg.modelType,
      prompt: msg.prompt,
      outputPath,
      modelId: msg.modelId,
      options: msg.options,
    });

    if (!result.success) {
      channel.send({
        type: "MEDIA_GEN_ERROR",
        requestId: msg.requestId,
        error: result.error ?? `${msg.modelType} generation failed on peer`,
      });
      return;
    }
    if ((result.error ?? "").toLowerCase().includes("placeholder")) {
      channel.send({
        type: "MEDIA_GEN_ERROR",
        requestId: msg.requestId,
        error:
          "Peer produced only a placeholder (no media provider available there).",
      });
      return;
    }

    const bytes = await fs.readFile(result.outputPath);
    let sentBytes = 0;
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      if (channel.isClosed()) {
        logger.warn(`[media ${shortId}] channel closed mid-transfer`);
        return;
      }
      const slice = bytes.subarray(
        offset,
        Math.min(offset + CHUNK_BYTES, bytes.length),
      );
      const eof = offset + CHUNK_BYTES >= bytes.length;
      const sent = channel.send({
        type: "MEDIA_GEN_CHUNK",
        requestId: msg.requestId,
        data: slice.toString("base64"),
        eof,
      });
      if (!sent) {
        logger.warn(`[media ${shortId}] send failed mid-transfer`);
        return;
      }
      sentBytes += slice.length;
    }
    // Zero-byte file edge case: still signal completion.
    if (bytes.length === 0) {
      channel.send({
        type: "MEDIA_GEN_CHUNK",
        requestId: msg.requestId,
        data: "",
        eof: true,
      });
    }
    logger.info(
      `[media ${shortId}] done: streamed ${sentBytes} bytes (${msg.modelType}, ${result.durationMs} ms)`,
    );
  } catch (err) {
    logger.error(`[media ${shortId}] failed:`, err);
    channel.send({
      type: "MEDIA_GEN_ERROR",
      requestId: msg.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    activeJobs -= 1;
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
  }
}
