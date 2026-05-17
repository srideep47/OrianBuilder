import { createAzure } from "@ai-sdk/azure";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import log from "electron-log";
import type { AzureProviderSetting } from "@/lib/schemas";

import { getEnvVar } from "../read_env";
import type { ModelProvider } from "./types";

const logger = log.scope("AzureProvider");

export const azureProvider: ModelProvider = {
  id: "azure",
  supportsStreaming: true,
  supportsTools: true,
  createClient({ model, settings, providerId }) {
    const testAzureBaseUrl = getEnvVar("TEST_AZURE_BASE_URL");

    if (testAzureBaseUrl) {
      logger.info(`Using test Azure base URL: ${testAzureBaseUrl}`);
      const provider = createOpenAICompatible({
        name: "azure-test",
        baseURL: testAzureBaseUrl,
        apiKey: "fake-api-key-for-testing",
      });
      return {
        model: provider(model.name),
        builtinProviderId: providerId,
      };
    }

    const azureSettings = settings.providerSettings?.azure as
      | AzureProviderSetting
      | undefined;
    const azureApiKeyFromSettings = (azureSettings?.apiKey?.value ?? "").trim();
    const azureResourceNameFromSettings = (
      azureSettings?.resourceName ?? ""
    ).trim();
    const envResourceName = (getEnvVar("AZURE_RESOURCE_NAME") ?? "").trim();
    const envAzureApiKey = (getEnvVar("AZURE_API_KEY") ?? "").trim();

    const resourceName = azureResourceNameFromSettings || envResourceName;
    const azureApiKey = azureApiKeyFromSettings || envAzureApiKey;

    if (!resourceName) {
      throw new Error(
        "Azure OpenAI resource name is required. Provide it in Settings or set the AZURE_RESOURCE_NAME environment variable.",
      );
    }

    if (!azureApiKey) {
      throw new Error(
        "Azure OpenAI API key is required. Provide it in Settings or set the AZURE_API_KEY environment variable.",
      );
    }

    const provider = createAzure({
      resourceName,
      apiKey: azureApiKey,
    });

    return {
      model: provider(model.name),
      builtinProviderId: providerId,
    };
  },
};
