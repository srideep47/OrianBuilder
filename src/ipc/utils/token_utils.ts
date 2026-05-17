import { LargeLanguageModel } from "@/lib/schemas";
import { readSettings } from "../../main/settings";
import { Message } from "@/ipc/types";

import { findLanguageModel } from "./findLanguageModel";
import { getLMStudioContextWindow } from "../handlers/local_model_lmstudio_handler";
import { getServerStatus } from "./embedded_inference_server";

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

  // For the embedded engine (llama-server child process or TensorRT), read
  // the actual loaded context size from the in-process status. Without this,
  // OrianBuilder falls back to 128K and sends 40K+ token codebase payloads to
  // a model loaded with 8K context — silent truncation, ~98-token outputs.
  if (model.provider === "embedded") {
    const size = getServerStatus().actualContextSize;
    if (size && size > 0) return size;
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

/** Smallest output budget we'll permit before refusing a turn. Below this the
 *  model truncates mid-write — that's the failure mode we're guarding against
 *  (broken file writes that take the preview down with a parse error). */
export const MIN_OUTPUT_BUDGET_TOKENS = 1024;

export interface OutputBudgetEstimate {
  contextWindow: number;
  estimatedInputTokens: number;
  outputBudget: number;
  /** True if outputBudget < MIN_OUTPUT_BUDGET_TOKENS — caller must not stream. */
  exhausted: boolean;
}

/**
 * Compute how many tokens of output headroom the model has *before* we hit
 * its context window. Used as a pre-flight check at the top of a chat turn:
 * if the codebase + history + system prompt already fill the window, sending
 * the turn produces mid-string truncation (see chat 97 / message 336, which
 * ended with `from-indigo-500 to\n</orianbuilder-write>` because the model
 * had ~13 tokens left to write with).
 */
export function estimateOutputBudget(input: {
  contextWindow: number;
  estimatedInputTokens: number;
}): OutputBudgetEstimate {
  const outputBudget = Math.max(
    0,
    input.contextWindow - input.estimatedInputTokens,
  );
  return {
    contextWindow: input.contextWindow,
    estimatedInputTokens: input.estimatedInputTokens,
    outputBudget,
    exhausted: outputBudget < MIN_OUTPUT_BUDGET_TOKENS,
  };
}
