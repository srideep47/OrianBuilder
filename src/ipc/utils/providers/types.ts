import type { LanguageModel } from "ai";
import type { LargeLanguageModel, UserSettings } from "@/lib/schemas";
import type { LanguageModelProvider } from "@/ipc/types";

export interface ModelClient {
  model: LanguageModel;
  builtinProviderId?: string;
}

export interface ProviderConfig {
  model: LargeLanguageModel;
  settings: UserSettings;
  providerConfig: LanguageModelProvider;
  apiKey?: string;
  providerId: string;
}

export interface ProviderClientResult {
  modelClient: ModelClient;
  backupModelClients: ModelClient[];
}

export interface ModelProvider {
  id: string;
  createClient(config: ProviderConfig): ModelClient;
  supportsStreaming: boolean;
  supportsTools: boolean;
}
