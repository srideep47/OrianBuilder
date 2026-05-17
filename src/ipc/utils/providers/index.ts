import type { LanguageModelProvider } from "@/ipc/types";

import { anthropicProvider } from "./AnthropicProvider";
import { azureProvider } from "./AzureProvider";
import { bedrockProvider } from "./BedrockProvider";
import { googleProvider } from "./GoogleProvider";
import {
  embeddedProvider,
  lmStudioProvider,
  ollamaProvider,
} from "./LocalLlamaProvider";
import { openAIProvider } from "./OpenAIProvider";
import { createOpenAiCompatibleModelProvider } from "./OpenAiCompatibleProvider";
import { openRouterProvider } from "./OpenRouterProvider";
import type { ModelProvider } from "./types";
import { vertexProvider } from "./VertexProvider";
import { xaiProvider } from "./XaiProvider";

const minimaxProvider = createOpenAiCompatibleModelProvider({
  id: "minimax",
  name: "minimax",
  baseURL: "https://api.minimax.io/v1",
});

const customProvider = createOpenAiCompatibleModelProvider({
  id: "custom",
  requireApiBaseUrl: true,
  builtinProviderId: false,
});

const providerMap: Record<string, ModelProvider> = {
  anthropic: anthropicProvider,
  azure: azureProvider,
  bedrock: bedrockProvider,
  embedded: embeddedProvider,
  google: googleProvider,
  lmstudio: lmStudioProvider,
  minimax: minimaxProvider,
  ollama: ollamaProvider,
  openai: openAIProvider,
  openrouter: openRouterProvider,
  vertex: vertexProvider,
  xai: xaiProvider,
};

export function getModelProvider(
  providerConfig: LanguageModelProvider,
): ModelProvider | null {
  if (providerConfig.type === "custom") {
    return customProvider;
  }

  return providerMap[providerConfig.id] ?? null;
}

export type {
  ModelClient,
  ModelProvider,
  ProviderClientResult,
  ProviderConfig,
} from "./types";
