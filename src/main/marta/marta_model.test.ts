import { afterEach, describe, expect, it, vi } from "vitest";

import { MartaModel } from "./marta_model";

const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MartaModel.completeStream", () => {
  it("forwards narration fragments and reconstructs streamed tool calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  'data: {"choices":[{"delta":{"content":"Hello "}}]}',
                  "",
                  'data: {"choices":[{"delta":{"content":"there.","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"open_","arguments":"{\\\"id\\\":"}}]}}]}',
                  "",
                  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"project","arguments":"7}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":4}}',
                  "",
                  "data: [DONE]",
                  "",
                ].join("\n"),
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const model = new MartaModel() as unknown as {
      backend: { getStatus: () => { running: boolean } };
      completeStream: MartaModel["completeStream"];
    };
    // The process backend is intentionally not started in this parser test.
    // Its public status is the only dependency of completeStream before fetch.
    model.backend = { getStatus: () => ({ running: true }) };

    const deltas: string[] = [];
    const result = await model.completeStream(
      [{ role: "user", content: "hello" }],
      {},
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(["Hello ", "there."]);
    expect(result).toMatchObject({
      content: "Hello there.",
      finishReason: "tool_calls",
      promptTokens: 12,
      completionTokens: 4,
      toolCalls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "open_project", arguments: '{"id":7}' },
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11534/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"stream":true'),
      }),
    );
  });
});

describe("readiness", () => {
  /**
   * The "fetch failed" bug, as a test.
   *
   * `LlamaServerStatus.running` is true from the moment the child process
   * spawns — seconds before `/health` accepts a request. A turn taken in that
   * window used to post immediately and surface the words "fetch failed" to the
   * user. Found by a live e2e run whose only symptom was an empty reply.
   */
  it("waits for an in-flight start before posting a completion", async () => {
    const order: string[] = [];
    let releaseStart: () => void = () => {};
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });

    const fetchMock = vi.fn().mockImplementation(async () => {
      order.push("fetch");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "hi" } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const model = new MartaModel() as unknown as {
      backend: {
        getStatus: () => { running: boolean; lastError: string | null };
        start: (options: unknown) => Promise<void>;
        stop: () => Promise<void>;
      };
      complete: MartaModel["complete"];
      hooks: MartaModel["hooks"];
    };
    model.backend = {
      // Deliberately optimistic, exactly like the real backend: the child is
      // alive before the HTTP server is listening.
      getStatus: () => ({ running: true, lastError: null }),
      start: async () => {
        await startGate;
        order.push("started");
      },
      stop: async () => {},
    };

    const load = model
      .hooks(
        () =>
          ({
            id: "4b",
            modelId: "test-4b",
            label: "Test 4B",
          }) as never,
      )
      .load({ modelId: "test-4b", placement: "gpu" } as never)
      // The staged model file does not exist in a unit test; only the ordering
      // against `complete` matters here.
      .catch(() => {
        order.push("started");
      });

    const completion = model.complete([{ role: "user", content: "hello" }]);

    // Nothing may be posted while the launch is still on the queue.
    expect(fetchMock).not.toHaveBeenCalled();
    releaseStart();
    await load;
    await completion;

    expect(order).toEqual(["started", "fetch"]);
  });

  it("reports the backend's own error instead of a bare 'not running'", async () => {
    const model = new MartaModel() as unknown as {
      backend: {
        getStatus: () => { running: boolean; lastError: string | null };
      };
      complete: MartaModel["complete"];
    };
    model.backend = {
      getStatus: () => ({
        running: false,
        lastError: "llama-server exited with code 1",
      }),
    };

    await expect(
      model.complete([{ role: "user", content: "hello" }]),
    ).rejects.toThrow("llama-server exited with code 1");
  });
});
