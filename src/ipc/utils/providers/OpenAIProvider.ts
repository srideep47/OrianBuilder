import { createOpenAI } from "@ai-sdk/openai";

import type { ModelProvider } from "./types";

export const openAIProvider: ModelProvider = {
  id: "openai",
  supportsStreaming: true,
  supportsTools: true,
  createClient({ model, apiKey, providerId }) {
    const provider = createOpenAI({ apiKey });
    return {
      model: provider.responses(model.name),
      builtinProviderId: providerId,
    };
  },
};
