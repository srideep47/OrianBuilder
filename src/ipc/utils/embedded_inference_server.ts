import http from "node:http";
import log from "electron-log";

const logger = log.scope("embedded-inference");

export const EMBEDDED_PORT = 11435;
export const EMBEDDED_BASE_URL = `http://127.0.0.1:${EMBEDDED_PORT}`;

let server: http.Server | null = null;
let llamaInstance: unknown = null;
let currentModel: unknown = null;
let currentContext: unknown = null;
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

// Cache the ESM module so we only load it once.
// We use `new Function` to create the dynamic import because Vite/Rollup
// rewrites static `import()` calls to `require()` in CJS bundles, which
// breaks ESM-only packages like node-llama-cpp that use top-level await.
// The Function wrapper is opaque to the bundler and preserves the real import().
const _esmImport = new Function("specifier", "return import(specifier)") as (
  s: string,
) => Promise<unknown>;
let llamaModule: typeof import("node-llama-cpp") | null = null;
async function getLlamaModule(): Promise<typeof import("node-llama-cpp")> {
  if (!llamaModule) {
    llamaModule = (await _esmImport(
      "node-llama-cpp",
    )) as typeof import("node-llama-cpp");
    logger.info("node-llama-cpp ESM module loaded");
  }
  return llamaModule;
}

export async function loadModel(config: EmbeddedModelConfig): Promise<void> {
  if (isLoading) throw new Error("A model is already loading");
  isLoading = true;
  logger.info(
    `Loading model: ${config.modelPath} (gpuLayers=${config.gpuLayers}, ctx=${config.contextSize})`,
  );

  try {
    await unloadModel();

    const { getLlama } = await getLlamaModule();

    if (!llamaInstance) {
      llamaInstance = await getLlama({ gpu: "auto" });
      logger.info("llama instance created");
    }

    // In node-llama-cpp v3, loadModel is an async method on the llama instance
    currentModel = await (llamaInstance as any).loadModel({
      modelPath: config.modelPath,
      gpuLayers: config.gpuLayers,
    });
    logger.info("Model loaded");

    currentContext = await (currentModel as any).createContext({
      contextSize: config.contextSize,
    });
    logger.info("Context created");

    currentModelPath = config.modelPath;
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
  currentModelPath = null;
  logger.info("Model unloaded");
}

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!currentContext || !currentModel) {
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
  const modelName = currentModelPath?.split(/[/\\]/).pop() ?? "embedded";

  const { LlamaChatSession } = await getLlamaModule();

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      const session = new LlamaChatSession({
        contextSequence: (currentContext as any).getSequence(),
        systemPrompt: undefined,
      });

      // Build the last user message as the prompt (session tracks history)
      const userMessages = messages.filter((m) => m.role !== "system");
      const systemMsg = messages.find((m) => m.role === "system");
      const lastUser = userMessages[userMessages.length - 1]?.content ?? "";

      // Re-inject system via wrapper if present
      const promptText = systemMsg
        ? `${systemMsg.content}\n\n${lastUser}`
        : lastUser;

      let tokenCount = 0;

      await session.prompt(promptText, {
        maxTokens,
        // node-llama-cpp v3 uses onTextChunk for streaming
        onTextChunk: (text: string) => {
          tokenCount++;
          const chunk = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [
              { index: 0, delta: { content: text }, finish_reason: null },
            ],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        },
      });

      const done = {
        id: `chatcmpl-${Date.now()}`,
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
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err) {
      logger.error("Inference error:", err);
      res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
      res.end();
    }
  } else {
    try {
      const session = new LlamaChatSession({
        contextSequence: (currentContext as any).getSequence(),
        systemPrompt: undefined,
      });

      const userMessages = messages.filter((m) => m.role !== "system");
      const systemMsg = messages.find((m) => m.role === "system");
      const lastUser = userMessages[userMessages.length - 1]?.content ?? "";
      const promptText = systemMsg
        ? `${systemMsg.content}\n\n${lastUser}`
        : lastUser;

      const output = await session.prompt(promptText, { maxTokens });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
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
        const modelName = currentModelPath?.split(/[/\\]/).pop() ?? "no-model";
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

    server.on("error", reject);
    server.listen(EMBEDDED_PORT, "127.0.0.1", () => {
      logger.info(
        `Embedded inference server listening on port ${EMBEDDED_PORT}`,
      );
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
    llamaModule = null;
  }
  if (!server) return;
  return new Promise((resolve) => {
    server!.close(() => {
      server = null;
      logger.info("Inference server stopped");
      resolve();
    });
  });
}
