import http from "node:http";
import log from "electron-log";

const logger = log.scope("embedded-inference");

export const EMBEDDED_PORT = 11435;
export const EMBEDDED_BASE_URL = `http://127.0.0.1:${EMBEDDED_PORT}`;

interface LlamaModule {
  getLlama: (opts: {
    gpu: "auto" | "cuda" | "cpu" | false;
  }) => Promise<unknown>;
  LlamaModel: new (opts: unknown) => unknown;
  LlamaContext: new (opts: unknown) => unknown;
  LlamaChatSession: new (opts: unknown) => unknown;
}

let server: http.Server | null = null;
let llamaInstance: unknown = null;
let currentModel: unknown = null;
let currentContext: unknown = null;
let currentSession: unknown = null;
let currentModelPath: string | null = null;
let isLoading = false;

export interface EmbeddedModelConfig {
  modelPath: string;
  gpuLayers: number;
  contextSize: number;
}

export interface EmbeddedServerStatus {
  running: boolean;
  modelLoaded: boolean;
  modelPath: string | null;
  isLoading: boolean;
}

export function getServerStatus(): EmbeddedServerStatus {
  return {
    running: server !== null,
    modelLoaded: currentModel !== null,
    modelPath: currentModelPath,
    isLoading,
  };
}

export async function loadModel(config: EmbeddedModelConfig): Promise<void> {
  if (isLoading) throw new Error("Model is already loading");
  isLoading = true;
  logger.info(
    `Loading model: ${config.modelPath} (gpuLayers=${config.gpuLayers}, ctx=${config.contextSize})`,
  );

  try {
    await unloadModel();

    // Dynamically import node-llama-cpp to avoid bundling issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const llama = require("node-llama-cpp") as LlamaModule;

    if (!llamaInstance) {
      llamaInstance = await llama.getLlama({ gpu: "auto" });
    }

    currentModel = new llama.LlamaModel({
      llama: llamaInstance,
      modelPath: config.modelPath,
      gpuLayers: config.gpuLayers,
    });

    currentContext = new llama.LlamaContext({
      model: currentModel,
      contextSize: config.contextSize,
    });

    currentSession = new llama.LlamaChatSession({
      contextSequence: (currentContext as any).getSequence(),
    });

    currentModelPath = config.modelPath;
    logger.info("Model loaded successfully");
  } finally {
    isLoading = false;
  }
}

export async function unloadModel(): Promise<void> {
  if (currentContext) {
    try {
      await (currentContext as any).dispose();
    } catch {
      /* ignore */
    }
    currentContext = null;
  }
  if (currentModel) {
    try {
      await (currentModel as any).dispose();
    } catch {
      /* ignore */
    }
    currentModel = null;
  }
  currentSession = null;
  currentModelPath = null;
  logger.info("Model unloaded");
}

function buildMessages(messages: { role: string; content: string }[]): string {
  return (
    messages
      .map((m) => {
        if (m.role === "system")
          return `<|im_start|>system\n${m.content}<|im_end|>`;
        if (m.role === "user")
          return `<|im_start|>user\n${m.content}<|im_end|>`;
        if (m.role === "assistant")
          return `<|im_start|>assistant\n${m.content}<|im_end|>`;
        return m.content;
      })
      .join("\n") + "\n<|im_start|>assistant\n"
  );
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!currentSession || !currentModel) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "No model loaded", type: "model_not_loaded" },
      }),
    );
    return;
  }

  const body = await readBody(req);
  const payload = JSON.parse(body);
  const messages: { role: string; content: string }[] = payload.messages ?? [];
  const stream: boolean = payload.stream ?? false;
  const maxTokens: number = payload.max_tokens ?? 4096;

  const prompt = buildMessages(messages);

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const modelName =
      currentModelPath?.split(/[/\\]/).pop() ?? "embedded-model";
    let tokenCount = 0;

    try {
      // Re-create session for each request to avoid state carryover
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const llama = require("node-llama-cpp") as LlamaModule;
      const freshSession = new llama.LlamaChatSession({
        contextSequence: (currentContext as any).getSequence(),
      });

      await (freshSession as any).prompt(prompt, {
        maxTokens,
        onToken: (token: string) => {
          tokenCount++;
          const chunk = {
            id: `chatcmpl-embedded-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [
              {
                index: 0,
                delta: { content: token },
                finish_reason: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        },
      });

      const doneChunk = {
        id: `chatcmpl-embedded-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          completion_tokens: tokenCount,
          prompt_tokens: 0,
          total_tokens: tokenCount,
        },
      };
      res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err) {
      logger.error("Inference error:", err);
      res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
      res.end();
    }
  } else {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const llama = require("node-llama-cpp") as LlamaModule;
      const freshSession = new llama.LlamaChatSession({
        contextSequence: (currentContext as any).getSequence(),
      });

      let output = "";
      await (freshSession as any).prompt(prompt, {
        maxTokens,
        onToken: (token: string) => {
          output += token;
        },
      });

      const modelName =
        currentModelPath?.split(/[/\\]/).pop() ?? "embedded-model";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-embedded-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: output },
              finish_reason: "stop",
            },
          ],
        }),
      );
    } catch (err) {
      logger.error("Inference error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err) } }));
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export function startServer(): Promise<void> {
  if (server) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url ?? "";

      if (url === "/v1/models" && req.method === "GET") {
        const modelName =
          currentModelPath?.split(/[/\\]/).pop() ?? "no-model-loaded";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: currentModel
              ? [
                  {
                    id: modelName,
                    object: "model",
                    created: 0,
                    owned_by: "orianbuilder",
                  },
                ]
              : [],
          }),
        );
        return;
      }

      if (url === "/v1/chat/completions" && req.method === "POST") {
        await handleChatCompletions(req, res);
        return;
      }

      if (url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ status: "ok", modelLoaded: currentModel !== null }),
        );
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    server.on("error", (err) => {
      logger.error("Server error:", err);
      reject(err);
    });

    server.listen(EMBEDDED_PORT, "127.0.0.1", () => {
      logger.info(`Embedded inference server started on port ${EMBEDDED_PORT}`);
      resolve();
    });
  });
}

export async function stopServer(): Promise<void> {
  await unloadModel();
  if (llamaInstance) {
    try {
      await (llamaInstance as any).dispose();
    } catch {
      /* ignore */
    }
    llamaInstance = null;
  }
  if (!server) return;
  return new Promise((resolve) => {
    server!.close(() => {
      server = null;
      logger.info("Embedded inference server stopped");
      resolve();
    });
  });
}
