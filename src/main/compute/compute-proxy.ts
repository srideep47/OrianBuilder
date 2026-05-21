/**
 * Compute Proxy — the "client" side of distributed inference.
 *
 * Spins up a local HTTP server on port 11436 that accepts OpenAI-compatible
 * requests and tunnels them to the selected remote peer over the Noise-encrypted
 * P2P channel. From the AI SDK's perspective it's just another OpenAI endpoint.
 *
 * Flow:
 *   AI SDK → http://127.0.0.1:11436/v1/chat/completions
 *           → P2P INFERENCE_REQUEST → peer's compute-node.ts
 *           ← P2P INFERENCE_CHUNK stream
 *           ← SSE response to AI SDK
 */

import http from "node:http";
import crypto from "node:crypto";
import log from "electron-log";
import { networkSwarm } from "@/main/network/swarm";

const logger = log.scope("compute:proxy");
export const PROXY_PORT = 11436;

let _server: http.Server | null = null;
let _activePeerId: string | null = null;

export function setProxyTarget(peerId: string | null): void {
  if (_activePeerId !== peerId) {
    logger.info(
      `Proxy target ${peerId ? `→ ${peerId.slice(0, 16)}…` : "cleared"}`,
    );
  }
  _activePeerId = peerId;
}

export function getProxyTarget(): string | null {
  return _activePeerId;
}

export function startProxy(): void {
  if (_server) return;

  _server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    // /v1/models is what the AI SDK probes to validate the endpoint.
    if (req.url?.includes("/models") && req.method === "GET") {
      res.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "remote-peer", object: "model", owned_by: "orion" }],
        }),
      );
      return;
    }

    if (!req.url?.includes("/chat/completions")) {
      res.writeHead(404, corsHeaders());
      res.end("Not found");
      return;
    }

    const peerId = _activePeerId;
    if (!peerId) {
      logger.warn("[proxy] request arrived but no peer target is set");
      res.writeHead(503, {
        ...corsHeaders(),
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          error: {
            message:
              "No remote compute target selected. Open the CPU picker in the top bar and choose a peer.",
            type: "no_peer_selected",
          },
        }),
      );
      return;
    }

    if (!networkSwarm.isPeerConnected(peerId)) {
      logger.warn(
        `[proxy] selected peer ${peerId.slice(0, 16)}… is not connected`,
      );
      res.writeHead(503, {
        ...corsHeaders(),
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          error: {
            message:
              "Selected peer is not connected. Wait for them to come online or pick a different device.",
            type: "peer_disconnected",
          },
        }),
      );
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const requestId = crypto.randomUUID();
      const shortId = requestId.slice(0, 8);
      logger.info(
        `[proxy ${shortId}] forwarding to peer ${peerId.slice(0, 16)}… (${body.length} bytes)`,
      );

      let headersSent = false;
      const ensureSseHeaders = () => {
        if (headersSent || res.headersSent) return;
        headersSent = true;
        res.writeHead(200, {
          ...corsHeaders(),
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
      };

      let bytesStreamed = 0;
      const cleanup = networkSwarm.sendInferenceRequest(
        peerId,
        requestId,
        body,
        (chunk) => {
          ensureSseHeaders();
          if (res.writableEnded) return;
          bytesStreamed += chunk.length;
          res.write(chunk);
        },
        (err) => {
          if (err) {
            logger.warn(`[proxy ${shortId}] ended with error: ${err}`);
            // Write the error as a visible SSE chat completion chunk so the
            // user actually SEES it in the chat. Falling back to HTTP 502 only
            // when no headers have been sent yet.
            if (!res.headersSent) {
              ensureSseHeaders();
            }
            if (!res.writableEnded) {
              const safeMsg = err
                .replace(/\\/g, "\\\\")
                .replace(/"/g, '\\"')
                .replace(/\n/g, " ");
              const visibleText = `[Remote inference failed] ${err}`;
              const created = Math.floor(Date.now() / 1000);
              // Emit a delta with the human-readable error text so the chat
              // shows it, then a final chunk with finish_reason and [DONE].
              res.write(
                `data: ${JSON.stringify({
                  id: requestId,
                  object: "chat.completion.chunk",
                  created,
                  model: "remote-peer",
                  choices: [
                    {
                      index: 0,
                      delta: { content: visibleText },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              );
              res.write(
                `data: ${JSON.stringify({
                  id: requestId,
                  object: "chat.completion.chunk",
                  created,
                  model: "remote-peer",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  error: { message: safeMsg, type: "remote_inference_failed" },
                })}\n\n`,
              );
              res.write("data: [DONE]\n\n");
              res.end();
            }
            return;
          }

          logger.info(
            `[proxy ${shortId}] done (${bytesStreamed} bytes streamed)`,
          );
          if (!res.writableEnded) {
            ensureSseHeaders();
            // If the upstream produced zero bytes, emit a friendly message
            // instead of a silent empty stream — otherwise the chat shows
            // nothing at all and the user thinks the app is broken.
            if (bytesStreamed === 0) {
              const created = Math.floor(Date.now() / 1000);
              const msg = `[Remote peer returned no output — they may need to load a model and toggle "Share my compute" on. Check Network → Diagnostics for details.]`;
              res.write(
                `data: ${JSON.stringify({
                  id: requestId,
                  object: "chat.completion.chunk",
                  created,
                  model: "remote-peer",
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: msg },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              );
              res.write(
                `data: ${JSON.stringify({
                  id: requestId,
                  object: "chat.completion.chunk",
                  created,
                  model: "remote-peer",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                })}\n\n`,
              );
              res.write("data: [DONE]\n\n");
            }
            res.end();
          }
        },
      );

      req.on("close", () => {
        cleanup?.();
        networkSwarm.cancelInferenceRequest(peerId, requestId);
      });
    });

    req.on("error", (err) => {
      logger.warn("[proxy] request error:", err);
    });
  });

  _server.listen(PROXY_PORT, "127.0.0.1", () => {
    logger.info(`Compute proxy listening on port ${PROXY_PORT}`);
  });

  _server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error(
        `Compute proxy port ${PROXY_PORT} is already in use — remote compute will not work until the port is freed.`,
      );
    } else {
      logger.error("Proxy server error:", err);
    }
  });
}

export function stopProxy(): void {
  _server?.close();
  _server = null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
