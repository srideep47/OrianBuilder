import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import type { ModelProvider } from "./types";

export function createOpenAiCompatibleModelProvider({
  id,
  name = id,
  baseURL,
  requireApiBaseUrl = false,
  builtinProviderId = true,
}: {
  id: string;
  name?: string;
  baseURL?: string;
  requireApiBaseUrl?: boolean;
  builtinProviderId?: boolean;
}): ModelProvider {
  return {
    id,
    supportsStreaming: true,
    supportsTools: true,
    createClient({ model, providerConfig, apiKey, providerId }) {
      const resolvedBaseURL = baseURL ?? providerConfig.apiBaseUrl;

      if (!resolvedBaseURL) {
        throw new Error(
          requireApiBaseUrl
            ? `Custom provider ${model.provider} is missing the API Base URL.`
            : `Provider ${model.provider} is missing the API Base URL.`,
        );
      }

      const provider = createOpenAICompatible({
        name,
        baseURL: resolvedBaseURL,
        apiKey,
      });

      return {
        model: provider(model.name),
        builtinProviderId: builtinProviderId ? providerId : undefined,
      };
    },
  };
}
