/**
 * Compute Node — the "server" side of distributed inference.
 *
 * When a trusted peer routes an inference request to this device, this module:
 *  1. Receives INFERENCE_REQUEST from the peer channel (after trust check in swarm.ts)
 *  2. Forwards the body to OrianBuilder's embedded inference engine on
 *     EMBEDDED_PORT (the same llama-server / TensorRT wrapper used by the
 *     Engine screen). We intentionally do NOT fall back to Ollama / LM Studio
 *     here — sharing should not depend on third-party tools being installed.
 *  3. Streams INFERENCE_CHUNK messages back to the requesting peer.
 *
 * If the requester sent a model name we don't have, we rewrite the body to use
 * whatever the embedded engine currently exposes (it only loads one model at
 * a time anyway). That way "load model X on device A → ask from device B"
 * works even if B has no idea of A's exact model file name.
 */

import log from "electron-log";
import type { PeerChannel } from "@/main/network/peer-channel";
import {
  getServerStatus,
  EMBEDDED_BASE_URL,
} from "@/ipc/utils/embedded_inference_server";

const logger = log.scope("compute:node");

// Active inference requests we're currently serving (requestId → AbortController)
const activeRequests = new Map<string, AbortController>();

const EMBEDDED_ENDPOINT = `${EMBEDDED_BASE_URL}/v1/chat/completions`;

export function getActiveRequestCount(): number {
  return activeRequests.size;
}

/** Called by swarm.ts when an INFERENCE_REQUEST arrives from a trusted peer. */
export async function handleInferenceRequest(
  channel: PeerChannel,
  requestId: string,
  bodyJson: string,
): Promise<void> {
  const shortId = requestId.slice(0, 8);
  const bodyPreview = bodyJson.slice(0, 200).replace(/\s+/g, " ");
  logger.info(
    `[recv ${shortId}] inference request from peer (${bodyJson.length} bytes)`,
  );
  logger.info(`[recv ${shortId}] body preview: ${bodyPreview}…`);

  const abort = new AbortController();
  activeRequests.set(requestId, abort);

  try {
    const status = getServerStatus();
    logger.info(
      `[recv ${shortId}] embedded status: backend=${status.backend} modelLoaded=${status.modelLoaded} modelName=${status.modelName ?? "-"} isInferring=${status.isInferring}`,
    );
    if (!status.modelLoaded) {
      logger.warn(
        `[recv ${shortId}] no model loaded in embedded engine — rejecting`,
      );
      channel.send({
        type: "INFERENCE_ERROR",
        requestId,
        error:
          "Host device has no model loaded in its OrianBuilder Engine. Ask them to load a model on the Engine screen, then retry.",
      });
      return;
    }

    const adjusted = adjustBodyForEmbeddedServer(bodyJson);
    logger.info(
      `[recv ${shortId}] forwarding to ${EMBEDDED_ENDPOINT} (model rewritten to "${status.modelName}")`,
    );
    const res = await fetchEmbedded(adjusted, abort.signal);
    if (!res) {
      channel.send({
        type: "INFERENCE_ERROR",
        requestId,
        error:
          "OrianBuilder embedded engine isn't responding on the host device. Try unloading and reloading the model on the Engine screen.",
      });
      return;
    }

    const ct = res.headers.get("content-type") ?? "";
    logger.info(
      `[recv ${shortId}] embedded responded HTTP ${res.status} content-type=${ct}`,
    );

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      logger.warn(
        `[recv ${shortId}] embedded engine HTTP ${res.status}: ${errText.slice(0, 200)}`,
      );
      channel.send({
        type: "INFERENCE_ERROR",
        requestId,
        error: `Embedded engine returned HTTP ${res.status}${errText ? `: ${errText.slice(0, 200)}` : ""}`,
      });
      return;
    }

    if (!res.body) {
      channel.send({
        type: "INFERENCE_ERROR",
        requestId,
        error: "Embedded engine returned an empty response body",
      });
      return;
    }

    // If the response isn't an SSE stream (e.g. llama-server returned a single
    // JSON object because stream:true was dropped), normalize it into a
    // synthetic SSE stream so the consumer's AI SDK still sees something.
    const isStream = ct.includes("text/event-stream");

    if (!isStream) {
      logger.warn(
        `[recv ${shortId}] non-SSE response (${ct}) — converting JSON to a single SSE delta`,
      );
      const json = await res.text();
      const synth = jsonToSyntheticSse(json, requestId);
      channel.send({ type: "INFERENCE_CHUNK", requestId, data: synth });
      channel.send({ type: "INFERENCE_DONE", requestId });
      logger.info(
        `[recv ${shortId}] completed (synthetic SSE from JSON, ${synth.length} bytes)`,
      );
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let firstChunkLogged = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (channel.isClosed()) {
        // Caller disconnected — stop reading and abort the upstream fetch.
        abort.abort();
        break;
      }
      const text = decoder.decode(value, { stream: true });
      totalBytes += text.length;
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        logger.info(
          `[recv ${shortId}] first SSE chunk (${text.length} bytes): ${text.slice(0, 120).replace(/\s+/g, " ")}…`,
        );
      }
      const sent = channel.send({
        type: "INFERENCE_CHUNK",
        requestId,
        data: text,
      });
      if (!sent) {
        logger.warn(
          `[recv ${shortId}] channel closed while streaming — aborting upstream`,
        );
        abort.abort();
        break;
      }
    }

    channel.send({ type: "INFERENCE_DONE", requestId });
    logger.info(
      `[recv ${shortId}] completed (${totalBytes} bytes streamed back)`,
    );
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "AbortError") {
      logger.info(`[recv ${shortId}] cancelled`);
    } else {
      logger.error(`[recv ${shortId}] failed:`, err);
      channel.send({
        type: "INFERENCE_ERROR",
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    activeRequests.delete(requestId);
  }
}

/**
 * Wrap a non-streaming JSON chat completion response into a single SSE event
 * + [DONE], so consumers that only know how to parse SSE still get content.
 */
function jsonToSyntheticSse(jsonText: string, requestId: string): string {
  try {
    const parsed = JSON.parse(jsonText);
    const content: string =
      parsed?.choices?.[0]?.message?.content ??
      parsed?.choices?.[0]?.delta?.content ??
      "";
    const chunk = {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: parsed?.model ?? "embedded",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content },
          finish_reason: null,
        },
      ],
    };
    const final = {
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`;
  } catch {
    return `data: {"error":{"message":"Embedded server returned non-JSON: ${jsonText
      .slice(0, 100)
      .replace(/"/g, '\\"')}"}}\n\ndata: [DONE]\n\n`;
  }
}

export function cancelRequest(requestId: string): void {
  activeRequests.get(requestId)?.abort();
  activeRequests.delete(requestId);
}

async function fetchEmbedded(
  bodyJson: string,
  signal: AbortSignal,
): Promise<Response | null> {
  try {
    return await fetch(EMBEDDED_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyJson,
      signal,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
      logger.warn(
        `Embedded engine not reachable on ${EMBEDDED_ENDPOINT} (code=${code})`,
      );
    } else {
      logger.warn(`Embedded engine fetch failed:`, err);
    }
    return null;
  }
}

/**
 * Rewrite `model` in the request to whatever the embedded engine currently
 * has loaded. llama.cpp's server actually ignores the model field, but using
 * the real name keeps the response metadata consistent and matches what the
 * peer is advertising in LOAD_UPDATE.
 */
function adjustBodyForEmbeddedServer(bodyJson: string): string {
  try {
    const parsed = JSON.parse(bodyJson);
    if (typeof parsed !== "object" || parsed === null) return bodyJson;
    const embedded = getServerStatus();
    if (embedded.modelLoaded && embedded.modelName) {
      parsed.model = embedded.modelName;
    }
    // Force streaming. Llama-server's default with stream omitted is a single
    // JSON response — we want SSE so the consumer's chat UI shows tokens as
    // they come back over the P2P channel.
    parsed.stream = true;
    return JSON.stringify(parsed);
  } catch {
    return bodyJson;
  }
}
