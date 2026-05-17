import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";

import { getEnvVar } from "../read_env";
import type { ModelProvider } from "./types";

export const bedrockProvider: ModelProvider = {
  id: "bedrock",
  supportsStreaming: true,
  supportsTools: true,
  createClient({ model, apiKey, providerId }) {
    const provider = createAmazonBedrock({
      apiKey,
      region: getEnvVar("AWS_REGION") || "us-east-1",
    });
    return {
      model: provider(model.name),
      builtinProviderId: providerId,
    };
  },
};
