import { createAnthropic } from "@ai-sdk/anthropic";

import type { ModelProvider } from "./types";

export const anthropicProvider: ModelProvider = {
  id: "anthropic",
  supportsStreaming: true,
  supportsTools: true,
  createClient({ model, apiKey, providerId }) {
    const provider = createAnthropic({ apiKey });
    return {
      model: provider(model.name),
      builtinProviderId: providerId,
    };
  },
};
