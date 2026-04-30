import { LargeLanguageModel } from "@/lib/schemas";
import { readSettings } from "../../main/settings";
import { Message } from "@/ipc/types";

import { findLanguageModel } from "./findLanguageModel";
import { getLMStudioContextWindow } from "../handlers/local_model_lmstudio_handler";
import http from "node:http";

// Estimate tokens (4 characters per token)
export const estimateTokens = (text: string): number => {
  return Math.ceil(text.length / 4);
};

export const estimateMessagesTokens = (messages: Message[]): number => {
  return messages.reduce(
    (acc, message) => acc + estimateTokens(message.content),
    0,
  );
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

// Query the embedded inference server's /health endpoint for the actual
// loaded context size. Mirrors getLMStudioContextWindow().
async function getEmbeddedContextWindow(): Promise<number | undefined> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: 11435, path: "/health", method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const size = body.contextSize as number | undefined;
            resolve(size && size > 0 ? size : undefined);
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    req.on("error", () => resolve(undefined));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(undefined);
    });
    req.end();
  });
}

export async function getContextWindow() {
  const settings = readSettings();
  const model = settings.selectedModel;

  // For LM Studio, fetch the real loaded context length from the API.
  // The catalog doesn't know local models, so the fallback of 128K is wrong
  // and causes compaction to never fire before the model throws a context error.
  if (model.provider === "lmstudio") {
    const lmsWindow = await getLMStudioContextWindow(model.name);
    if (lmsWindow) return lmsWindow;
  }

  // For the embedded node-llama-cpp engine, query the actual loaded context size.
  // Without this, Dyad falls back to 128K and sends 40K+ token codebase payloads
  // to a model loaded with 8K context — causing silent truncation and ~98-token outputs.
  if (model.provider === "embedded") {
    const embeddedWindow = await getEmbeddedContextWindow();
    if (embeddedWindow) return embeddedWindow;
  }

  const modelOption = await findLanguageModel(model);
  return modelOption?.contextWindow || DEFAULT_CONTEXT_WINDOW;
}

export async function getMaxTokens(
  model: LargeLanguageModel,
): Promise<number | undefined> {
  const modelOption = await findLanguageModel(model);
  return modelOption?.maxOutputTokens ?? undefined;
}

export async function getTemperature(
  model: LargeLanguageModel,
): Promise<number | undefined> {
  const modelOption = await findLanguageModel(model);
  if (modelOption?.type === "custom") {
    return modelOption.temperature;
  }
  return modelOption?.temperature ?? 0;
}

/**
 * Calculate the token threshold for triggering context compaction.
 * Returns the minimum of 80% of context window or 180k tokens.
 */
export function getCompactionThreshold(contextWindow: number): number {
  return Math.min(Math.floor(contextWindow * 0.8), 180_000);
}

/**
 * Check if compaction should be triggered based on total tokens used.
 */
export function shouldTriggerCompaction(
  totalTokens: number,
  contextWindow: number,
): boolean {
  return totalTokens >= getCompactionThreshold(contextWindow);
}
