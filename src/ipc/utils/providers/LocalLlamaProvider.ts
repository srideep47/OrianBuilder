import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { getOllamaApiUrl } from "@/ipc/handlers/local_model_ollama_handler";
import { getServerStatus } from "@/ipc/utils/embedded_inference_server";
import { LM_STUDIO_BASE_URL } from "@/ipc/utils/lm_studio_utils";
import { localModelFetch } from "@/ipc/utils/local_model_fetch";
import { createOllamaProvider } from "@/ipc/utils/ollama_provider";

import type { ModelProvider } from "./types";

export const ollamaProvider: ModelProvider = {
  id: "ollama",
  supportsStreaming: true,
  supportsTools: true,
  createClient({ model, providerId }) {
    const provider = createOllamaProvider({
      baseURL: getOllamaApiUrl(),
      fetch: localModelFetch,
    });
    return {
      model: provider(model.name),
      builtinProviderId: providerId,
    };
  },
};

export const lmStudioProvider: ModelProvider = {
  id: "lmstudio",
  supportsStreaming: true,
  supportsTools: true,
  createClient({ model, providerConfig }) {
    const baseURL = providerConfig.apiBaseUrl || LM_STUDIO_BASE_URL + "/v1";
    const provider = createOpenAICompatible({
      name: "lmstudio",
      baseURL,
      fetch: localModelFetch,
    });
    return {
      model: provider(model.name),
    };
  },
};

export const embeddedProvider: ModelProvider = {
  id: "embedded",
  supportsStreaming: true,
  supportsTools: false,
  createClient({ model, settings }) {
    const status = getServerStatus();
    if (
      settings.selectedChatMode === "local-agent" ||
      settings.selectedChatMode === "ask" ||
      settings.selectedChatMode === "plan"
    ) {
      if (status.backend === "tensorrt-native") {
        throw new OrianBuilderError(
          "The embedded TensorRT backend does not support app-building agent tool calls yet. Reload the model with the llama.cpp backend, or choose Ollama, LM Studio, or a cloud model for Build/Ask/Plan mode.",
          OrianBuilderErrorKind.Precondition,
        );
      }
    }

    const provider = createOpenAICompatible({
      name: "embedded",
      baseURL: "http://127.0.0.1:11435/v1",
      fetch: localModelFetch,
    });
    return {
      model: provider(status.modelName ?? model.name),
    };
  },
};
