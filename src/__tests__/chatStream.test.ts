import { describe, expect, it, vi } from "vitest";
import { consumeSSEStream } from "@/lib/chatStream";

describe("consumeSSEStream", () => {
  it("formats mirrored reasoning deltas as a think block", async () => {
    const chunks = [
      sseChunk({
        choices: [
          {
            finish_reason: null,
            index: 0,
            delta: { reasoning_content: "Thinking", content: "Thinking" },
          },
        ],
      }),
      sseChunk({
        choices: [
          {
            finish_reason: null,
            index: 0,
            delta: { reasoning_content: " Process", content: " Process" },
          },
        ],
      }),
      sseChunk({
        choices: [
          {
            finish_reason: null,
            index: 0,
            delta: { content: "Hello." },
          },
        ],
      }),
      "data: [DONE]\n\n",
    ];

    let content = "";
    await consumeSSEStream(responseFromChunks(chunks), {
      onChunk: (delta) => {
        content += delta;
      },
      onEnd: vi.fn(),
      onError: (message) => {
        throw new Error(message);
      },
    });

    expect(content).toBe("<think>Thinking Process</think>\n\nHello.");
  });
});

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}
