/**
 * Compute Node — the "server" side of distributed inference.
 *
 * When a trusted peer routes an inference request to this device, this module:
 *  1. Receives INFERENCE_REQUEST from the peer channel
 *  2. Forwards it to the local inference server (llama-server port 11435 or Ollama 11434)
 *  3. Streams INFERENCE_CHUNK messages back to the requesting peer
 */

import log from "electron-log";
import type { PeerChannel } from "@/main/network/peer-channel";

const logger = log.scope("compute:node");

// Active inference requests we're currently serving (requestId → AbortController)
const activeRequests = new Map<string, AbortController>();

export function getActiveRequestCount(): number {
  return activeRequests.size;
}

/** Called by swarm.ts when an INFERENCE_REQUEST arrives from a peer channel. */
export async function handleInferenceRequest(
  channel: PeerChannel,
  requestId: string,
  bodyJson: string,
): Promise<void> {
  logger.info(`Inference request ${requestId.slice(0, 8)} received`);

  const abort = new AbortController();
  activeRequests.set(requestId, abort);

  try {
    // Try llama-server first, fall back to Ollama
    const endpoints = [
      "http://127.0.0.1:11435/v1/chat/completions",
      "http://127.0.0.1:11434/v1/chat/completions",
    ];

    let res: Response | null = null;
    for (const url of endpoints) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyJson,
          signal: abort.signal,
        });
        if (res.ok) break;
      } catch {
        // try next endpoint
      }
    }

    if (!res || !res.ok || !res.body) {
      channel.send({
        type: "INFERENCE_ERROR",
        requestId,
        error: "No local inference server available",
      });
      return;
    }

    // Stream SSE chunks back to the requesting peer
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      channel.send({ type: "INFERENCE_CHUNK", requestId, data: text });
    }

    channel.send({ type: "INFERENCE_DONE", requestId });
    logger.info(`Inference request ${requestId.slice(0, 8)} completed`);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "AbortError") {
      logger.info(`Inference request ${requestId.slice(0, 8)} cancelled`);
    } else {
      logger.error(`Inference request ${requestId.slice(0, 8)} failed:`, err);
      channel.send({ type: "INFERENCE_ERROR", requestId, error: String(err) });
    }
  } finally {
    activeRequests.delete(requestId);
  }
}

export function cancelRequest(requestId: string): void {
  activeRequests.get(requestId)?.abort();
  activeRequests.delete(requestId);
}
