/**
 * Qwen-aware sampling parameters.
 *
 * The Qwen model card specifies recommended sampling values that differ
 * significantly from the AI SDK / OpenAI defaults. Running Qwen with
 * `temperature: 0` (our default) collapses the distribution and causes
 * the well-documented "repeats one phrase forever" / "emits tool calls
 * as text" failure modes. The official Qwen 3.6 model card recommends:
 *
 *   Thinking mode, coding:  temperature=0.6, top_p=0.95, top_k=20
 *   Thinking mode, general: temperature=1.0, top_p=0.95, top_k=20, presence_penalty=1.5
 *   Non-thinking, general:  temperature=0.7, top_p=0.80, top_k=20, presence_penalty=1.5
 *
 * Source: https://huggingface.co/Qwen/Qwen3.6-27B
 *
 * We detect Qwen models by name and apply the coding profile, since the
 * local agent is doing code generation / tool calling work.
 */

import type { LargeLanguageModel } from "@/lib/schemas";

export interface QwenSamplingParams {
  temperature: number;
  topP: number;
  topK: number;
  presencePenalty: number;
}

const QWEN_NAME_RE = /\bqwen[\s_-]?(?:3|2\.5|coder)/i;

export function isQwenModel(model: LargeLanguageModel): boolean {
  if (!model) return false;
  if (typeof model.name === "string" && QWEN_NAME_RE.test(model.name)) {
    return true;
  }
  return false;
}

/**
 * Profile tuned for code generation + tool calling — what the local agent
 * does. Mirrors the "Thinking mode, precise coding" recommendation from the
 * official Qwen 3.6 27B model card and Unsloth's Qwen3.6 guide.
 */
export const QWEN_CODING_SAMPLING: QwenSamplingParams = {
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  presencePenalty: 0,
};
