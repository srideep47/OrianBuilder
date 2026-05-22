import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localModelFetch } from "@/ipc/utils/local_model_fetch";
import {
  setProxyTarget,
  startProxy,
  stopProxy,
} from "@/main/compute/compute-proxy";

const networkMocks = vi.hoisted(() => ({
  isPeerConnected: vi.fn(),
  sendInferenceRequest: vi.fn(),
  cancelInferenceRequest: vi.fn(),
}));

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

vi.mock("@/main/network/swarm", () => ({
  networkSwarm: networkMocks,
}));

const TEST_PROXY_PORT = 19361;
const proxyBaseUrl = `http://127.0.0.1:${TEST_PROXY_PORT}/v1`;

describe("compute proxy", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    networkMocks.isPeerConnected.mockReturnValue(true);
    setProxyTarget("peer-1");
    startProxy(TEST_PROXY_PORT);
    await waitForProxy();
  });

  afterEach(async () => {
    setProxyTarget(null);
    stopProxy();
    await new Promise((resolve) => setTimeout(resolve, 25));
  });

  it("keeps the P2P inference handler alive after the POST request body closes", async () => {
    const cleanup = vi.fn();
    networkMocks.sendInferenceRequest.mockImplementation(
      (_peerId, _requestId, _body, onChunk, onDone) => {
        let cleanedUp = false;
        cleanup.mockImplementation(() => {
          cleanedUp = true;
          onDone();
        });

        setTimeout(() => {
          if (cleanedUp) return;
          onChunk(
            `data: ${JSON.stringify({
              choices: [
                {
                  finish_reason: null,
                  index: 0,
                  delta: { role: "assistant", content: null },
                },
              ],
              created: 1,
              id: "chatcmpl-test",
              model: "remote-peer",
              object: "chat.completion.chunk",
            })}\n\n`,
          );
          onChunk(
            `data: ${JSON.stringify({
              choices: [
                {
                  finish_reason: null,
                  index: 0,
                  delta: { content: "Thinking" },
                },
              ],
              created: 1,
              id: "chatcmpl-test",
              model: "remote-peer",
              object: "chat.completion.chunk",
            })}\n\n`,
          );
          onChunk(
            `data: ${JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  index: 0,
                  delta: {},
                },
              ],
              created: 1,
              id: "chatcmpl-test",
              model: "remote-peer",
              object: "chat.completion.chunk",
            })}\n\n`,
          );
          onChunk("data: [DONE]\n\n");
          onDone();
        }, 25);

        return cleanup;
      },
    );

    const res = await localModelFetch(`${proxyBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "remote-peer",
        messages: [{ role: "user", content: "Say hi." }],
        stream: true,
      }),
    });

    const raw = await readResponseText(res);

    expect(raw).toContain('"content":"Thinking"');
    expect(raw).not.toContain("Remote peer returned no output");
    expect(cleanup).not.toHaveBeenCalled();
    expect(networkMocks.cancelInferenceRequest).not.toHaveBeenCalled();
  });
});

async function waitForProxy(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await localModelFetch(`${proxyBaseUrl}/models`, {
        method: "GET",
      });
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("compute proxy did not start");
}

async function readResponseText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  reader.releaseLock();
  return text;
}
