import { createGoogleGenerativeAI as createGoogle } from "@ai-sdk/google";

import type { ModelProvider } from "./types";

export const googleProvider: ModelProvider = {
  id: "google",
  supportsStreaming: true,
  supportsTools: true,
  createClient({ model, apiKey, providerId }) {
    const provider = createGoogle({ apiKey });
    return {
      model: provider(model.name),
      builtinProviderId: providerId,
    };
  },
};
