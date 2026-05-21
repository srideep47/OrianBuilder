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

    if (!req.url?.includes("/chat/completions")) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const peerId = _activePeerId;
    if (!peerId) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "No peer target set" }));
      return;
    }

    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      const requestId = crypto.randomUUID();

      res.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const cleanup = networkSwarm.sendInferenceRequest(
        peerId,
        requestId,
        body,
        (chunk) => {
          res.write(chunk);
        },
        (err) => {
          if (!res.writableEnded) {
            if (err) {
              res.write(`data: {"error":"${err}"}\n\n`);
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
  });

  _server.listen(PROXY_PORT, "127.0.0.1", () => {
    logger.info(`Compute proxy listening on port ${PROXY_PORT}`);
  });

  _server.on("error", (err) => {
    logger.error("Proxy server error:", err);
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
