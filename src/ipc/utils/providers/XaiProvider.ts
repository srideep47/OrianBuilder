import { createXai } from "@ai-sdk/xai";

import type { ModelProvider } from "./types";

export const xaiProvider: ModelProvider = {
  id: "xai",
  supportsStreaming: true,
  supportsTools: true,
  createClient({ model, apiKey, providerId }) {
    const provider = createXai({ apiKey });
    return {
      model: provider(model.name),
      builtinProviderId: providerId,
    };
  },
};
