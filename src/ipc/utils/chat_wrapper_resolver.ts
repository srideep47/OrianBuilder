/**
 * Resolves the right node-llama-cpp chat wrapper for a given GGUF model file.
 *
 * node-llama-cpp can auto-detect a chat wrapper from a model's GGUF metadata,
 * but the auto-detector relies on the chat template embedded in the file. Many
 * community quants (especially the Qwen 3.x family, DeepSeek Coder, and some
 * Llama 3.x re-quants) ship with stripped, custom, or incorrect templates,
 * which causes node-llama-cpp to fall back to a generic wrapper that does not
 * surface tool calls correctly. The agent then sees the model emit
 * `<tool_call>{...}` as plain text and the loop stalls.
 *
 * This resolver inspects the filename to pick a wrapper from the
 * specialized set node-llama-cpp ships with. When the family matches a
 * well-known one we instantiate the matching wrapper class so tool calling
 * works reliably. Qwen 3.5/3.6 GGUFs are the exception: their embedded Jinja
 * template is more reliable than the generic Qwen wrapper. When no confident
 * match is found we return `null` and let node-llama-cpp auto-resolve (with
 * the text-tool-call fallback in the agent loop catching any leakage).
 */

import log from "electron-log";

const logger = log.scope("chat_wrapper_resolver");

export type ChatWrapperMatch = {
  family:
    | "qwen"
    | "llama-3.1"
    | "llama-3"
    | "llama-2"
    | "deepseek"
    | "mistral"
    | "gemma"
    | "functionary"
    | "harmony"
    | "chatml"
    | "alpaca"
    | "falcon"
    | "unknown";
  // Free-form label used in logs and mission events.
  label: string;
  /**
   * Factory that constructs the wrapper instance. Lazy so we never pull node-
   * llama-cpp into the renderer bundle. Returns `null` when node-llama-cpp
   * does not export a wrapper for this family (e.g. unknown).
   */
  build: (
    module: typeof import("node-llama-cpp"),
  ) => InstanceType<typeof import("node-llama-cpp").ChatWrapper> | null;
};

/**
 * Identify the model family from a GGUF filename or model id. Returns the
 * earliest pattern that matches; order is important so newer families take
 * precedence over older families with overlapping naming (e.g. Llama 3.1
 * before Llama 3).
 */
export function detectModelFamily(
  modelIdOrFilename: string | undefined | null,
): ChatWrapperMatch {
  if (!modelIdOrFilename) {
    return { family: "unknown", label: "unknown", build: () => null };
  }
  const haystack = modelIdOrFilename.toLowerCase();

  // Qwen 3.5/3.6 GGUFs ship a working Jinja chat template. Forcing the older
  // generic Qwen wrapper can terminate immediately with an empty response.
  if (/(?:^|[\W_])qwen[\W_]?3(?:[._-]?[56])(?:[\W_]|$)/i.test(haystack)) {
    return {
      family: "qwen",
      label: "Qwen 3.5/3.6 (GGUF Jinja template)",
      build: () => null,
    };
  }

  // Qwen 2.5 / Qwen 3.0-style models: Hermes-style tags via QwenChatWrapper.
  if (
    /(?:^|[\W_])qwen[\W_]?[23]/i.test(haystack) ||
    /qwen-?coder/i.test(haystack)
  ) {
    return {
      family: "qwen",
      label: "Qwen 2.5/3.x (Hermes-style tool calls)",
      build: (m) => new m.QwenChatWrapper(),
    };
  }

  // DeepSeek Coder / DeepSeek-V2 / DeepSeek-V3 — bespoke wrapper.
  if (/deepseek/i.test(haystack)) {
    return {
      family: "deepseek",
      label: "DeepSeek",
      build: (m) => new m.DeepSeekChatWrapper(),
    };
  }

  // GPT-OSS / Harmony format models.
  if (/harmony|gpt-?oss/i.test(haystack)) {
    return {
      family: "harmony",
      label: "Harmony (GPT-OSS)",
      build: (m) => new m.HarmonyChatWrapper(),
    };
  }

  // Functionary v2/v3 — purpose-built for function calls.
  if (/functionary/i.test(haystack)) {
    return {
      family: "functionary",
      label: "Functionary",
      build: (m) => new m.FunctionaryChatWrapper(),
    };
  }

  // Llama 3.1+ — best tool-call support in this generation.
  if (/llama-?3\.[12]|llama-?3-?1|llama-?3-?2|llama-?3-?3/i.test(haystack)) {
    return {
      family: "llama-3.1",
      label: "Llama 3.1+",
      build: (m) => new m.Llama3_1ChatWrapper(),
    };
  }

  // Llama 3 — no native tool calls; rely on the text fallback parser.
  if (/llama-?3/i.test(haystack)) {
    return {
      family: "llama-3",
      label: "Llama 3",
      build: (m) => new m.Llama3ChatWrapper(),
    };
  }

  // Llama 2 — heritage models.
  if (/llama-?2/i.test(haystack)) {
    return {
      family: "llama-2",
      label: "Llama 2",
      build: (m) => new m.Llama2ChatWrapper(),
    };
  }

  // Mistral / Mixtral.
  if (/mistral|mixtral|codestral/i.test(haystack)) {
    return {
      family: "mistral",
      label: "Mistral / Mixtral",
      build: (m) => new m.MistralChatWrapper(),
    };
  }

  // Google Gemma 1/2/3.
  if (/gemma/i.test(haystack)) {
    return {
      family: "gemma",
      label: "Gemma",
      build: (m) => new m.GemmaChatWrapper(),
    };
  }

  // Generic ChatML or Alpaca/Falcon — last resort known formats.
  if (/chatml|hermes/i.test(haystack)) {
    return {
      family: "chatml",
      label: "ChatML (Hermes-style)",
      build: (m) => new m.ChatMLChatWrapper(),
    };
  }
  if (/alpaca|vicuna/i.test(haystack)) {
    return {
      family: "alpaca",
      label: "Alpaca",
      build: (m) => new m.AlpacaChatWrapper(),
    };
  }
  if (/falcon/i.test(haystack)) {
    return {
      family: "falcon",
      label: "Falcon",
      build: (m) => new m.FalconChatWrapper(),
    };
  }

  return { family: "unknown", label: "unknown", build: () => null };
}

/**
 * Resolve and instantiate the chat wrapper for a model, returning `null` if
 * we have no confident match (caller should let node-llama-cpp auto-resolve).
 */
export async function resolveChatWrapperForModel(input: {
  modelIdOrFilename: string;
  llamaModule: typeof import("node-llama-cpp");
}): Promise<{
  wrapper: InstanceType<typeof import("node-llama-cpp").ChatWrapper> | null;
  match: ChatWrapperMatch;
}> {
  const match = detectModelFamily(input.modelIdOrFilename);
  if (match.family === "unknown") {
    logger.info(
      `[chat_wrapper] No confident match for "${input.modelIdOrFilename}" — falling back to node-llama-cpp auto-detect.`,
    );
    return { wrapper: null, match };
  }
  try {
    const wrapper = match.build(input.llamaModule);
    if (!wrapper) {
      return { wrapper: null, match };
    }
    logger.info(
      `[chat_wrapper] Using ${match.label} wrapper for "${input.modelIdOrFilename}".`,
    );
    return { wrapper, match };
  } catch (err) {
    logger.warn(
      `[chat_wrapper] Failed to instantiate ${match.label} wrapper for "${input.modelIdOrFilename}":`,
      err,
    );
    return { wrapper: null, match };
  }
}
