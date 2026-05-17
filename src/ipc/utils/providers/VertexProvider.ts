import { createVertex as createGoogleVertex } from "@ai-sdk/google-vertex";
import type { VertexProviderSetting } from "@/lib/schemas";

import type { ModelProvider } from "./types";

export const vertexProvider: ModelProvider = {
  id: "vertex",
  supportsStreaming: true,
  supportsTools: true,
  createClient({ model, settings, providerId }) {
    const vertexSettings = settings.providerSettings?.[
      model.provider
    ] as VertexProviderSetting;
    const project = vertexSettings?.projectId;
    const location = vertexSettings?.location;
    const serviceAccountKey = vertexSettings?.serviceAccountKey?.value;

    // Use a baseURL that does NOT pin to publishers/google so that
    // full publisher model IDs (e.g. publishers/deepseek-ai/models/...) work.
    const regionHost = `${location === "global" ? "" : `${location}-`}aiplatform.googleapis.com`;
    const baseURL = `https://${regionHost}/v1/projects/${project}/locations/${location}`;
    const provider = createGoogleVertex({
      project,
      location,
      baseURL,
      googleAuthOptions: serviceAccountKey
        ? {
            // Expecting the user to paste the full JSON of the service account key
            credentials: JSON.parse(serviceAccountKey),
          }
        : undefined,
    });

    return {
      model: provider(
        model.name.includes("/")
          ? model.name
          : `publishers/google/models/${model.name}`,
      ),
      builtinProviderId: providerId,
    };
  },
};
