import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";

import type { ModelProvider } from "./types";

export const openRouterProvider: ModelProvider = {
  id: "openrouter",
  supportsStreaming: true,
  supportsTools: true,
  createClient({ model, apiKey, providerId }) {
    if (!apiKey) {
      throw new OrianBuilderError(
        "OpenRouter API key is missing. Go to Settings -> Engine -> OpenRouter and add your API key from openrouter.ai/settings/keys",
        OrianBuilderErrorKind.Auth,
      );
    }

    const provider = createOpenAICompatible({
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://orianbuilder.com",
        "X-Title": "OrianBuilder",
      },
    });

    return {
      model: provider(model.name),
      builtinProviderId: providerId,
    };
  },
};
