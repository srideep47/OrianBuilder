import { OpenAICompatibleChatLanguageModel } from "@ai-sdk/openai-compatible";
import { OpenAIResponsesLanguageModel } from "@ai-sdk/openai/internal";
import {
  FetchFunction,
  loadApiKey,
  withoutTrailingSlash,
} from "@ai-sdk/provider-utils";

import log from "electron-log";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { getExtraProviderOptions } from "./thinking_utils";
import { ORIANBUILDER_INTERNAL_REQUEST_ID_HEADER } from "./provider_options";
import type { UserSettings } from "../../lib/schemas";
import type { LanguageModel } from "ai";

const logger = log.scope("llm_engine_provider");

export type ExampleChatModelId = string & {};
export interface ChatParams {
  providerId: string;
}
export interface ExampleProviderSettings {
  /**
Example API key.
*/
  apiKey?: string;
  /**
Base URL for the API calls.
*/
  baseURL?: string;
  /**
Custom headers to include in the requests.
*/
  headers?: Record<string, string>;
  /**
Optional custom url query parameters to include in request urls.
*/
  queryParams?: Record<string, string>;
  /**
Custom fetch implementation. You can use it as a middleware to intercept requests,
or to provide a custom fetch implementation for e.g. testing.
*/
  fetch?: FetchFunction;

  orianbuilderOptions: {
    enableLazyEdits?: boolean;
    enableSmartFilesContext?: boolean;
    enableWebSearch?: boolean;
  };
  settings: UserSettings;
}

export interface OrianBuilderEngineProvider {
  /**
Creates a model for text generation.
*/
  (modelId: ExampleChatModelId, chatParams: ChatParams): LanguageModel;

  /**
Creates a chat model for text generation.
*/
  chatModel(modelId: ExampleChatModelId, chatParams: ChatParams): LanguageModel;

  responses(modelId: ExampleChatModelId, chatParams: ChatParams): LanguageModel;
}

export function createOrianBuilderEngine(
  options: ExampleProviderSettings,
): OrianBuilderEngineProvider {
  const baseURL = withoutTrailingSlash(options.baseURL);
  logger.info("creating orianbuilder engine with baseURL", baseURL);

  // Track request ID attempts
  const requestIdAttempts = new Map<string, number>();

  const getHeaders = () => ({
    Authorization: `Bearer ${loadApiKey({
      apiKey: options.apiKey,
      environmentVariableName: "ORIANBUILDER_PRO_API_KEY",
      description: "Example API key",
    })}`,
    ...options.headers,
  });

  interface CommonModelConfig {
    provider: string;
    url: ({ path }: { path: string }) => string;
    headers: () => Record<string, string>;
    fetch?: FetchFunction;
  }

  const getCommonModelConfig = (): CommonModelConfig => ({
    provider: `orianbuilder-engine`,
    url: ({ path }) => {
      const url = new URL(`${baseURL}${path}`);
      if (options.queryParams) {
        url.search = new URLSearchParams(options.queryParams).toString();
      }
      return url.toString();
    },
    headers: getHeaders,
    fetch: options.fetch,
  });

  // Custom fetch implementation that adds orianbuilder-specific options to the request
  const createOrianBuilderFetch = ({
    providerId,
  }: {
    providerId: string;
  }): FetchFunction => {
    return (input: RequestInfo | URL, init?: RequestInit) => {
      // Use default fetch if no init or body
      if (!init || !init.body || typeof init.body !== "string") {
        return (options.fetch || fetch)(input, init);
      }

      try {
        // Parse the request body to manipulate it
        const parsedBody = {
          ...JSON.parse(init.body),
          ...getExtraProviderOptions(providerId, options.settings),
        };

        const orianbuilderVersionedFiles =
          parsedBody.orianbuilderVersionedFiles;
        if ("orianbuilderVersionedFiles" in parsedBody) {
          delete parsedBody.orianbuilderVersionedFiles;
        }
        const orianbuilderFiles = parsedBody.orianbuilderFiles;
        if ("orianbuilderFiles" in parsedBody) {
          delete parsedBody.orianbuilderFiles;
        }
        // Read from body (OpenAICompatible models spread providerOptions into
        // the body) with a fallback to an internal header (OpenAIResponses
        // models don't forward providerOptions, so we pass it via header).
        const requestId =
          parsedBody.orianbuilderRequestId ??
          (init.headers as Record<string, string> | undefined)?.[
            ORIANBUILDER_INTERNAL_REQUEST_ID_HEADER
          ];
        if ("orianbuilderRequestId" in parsedBody) {
          delete parsedBody.orianbuilderRequestId;
        }
        const orianbuilderAppId = parsedBody.orianbuilderAppId;
        if ("orianbuilderAppId" in parsedBody) {
          delete parsedBody.orianbuilderAppId;
        }
        const orianbuilderDisableFiles = parsedBody.orianbuilderDisableFiles;
        if ("orianbuilderDisableFiles" in parsedBody) {
          delete parsedBody.orianbuilderDisableFiles;
        }
        const orianbuilderMentionedApps = parsedBody.orianbuilderMentionedApps;
        if ("orianbuilderMentionedApps" in parsedBody) {
          delete parsedBody.orianbuilderMentionedApps;
        }
        const orianbuilderSmartContextMode =
          parsedBody.orianbuilderSmartContextMode;
        if ("orianbuilderSmartContextMode" in parsedBody) {
          delete parsedBody.orianbuilderSmartContextMode;
        }

        // Track and modify requestId with attempt number
        let modifiedRequestId = requestId;
        if (requestId) {
          const currentAttempt = (requestIdAttempts.get(requestId) || 0) + 1;
          requestIdAttempts.set(requestId, currentAttempt);
          modifiedRequestId = `${requestId}:attempt-${currentAttempt}`;
        }

        // Add files to the request if they exist
        if (!orianbuilderDisableFiles) {
          parsedBody.orianbuilder_options = {
            files: orianbuilderFiles,
            versioned_files: orianbuilderVersionedFiles,
            enable_lazy_edits: options.orianbuilderOptions.enableLazyEdits,
            enable_smart_files_context:
              options.orianbuilderOptions.enableSmartFilesContext,
            smart_context_mode: orianbuilderSmartContextMode,
            enable_web_search: options.orianbuilderOptions.enableWebSearch,
            app_id: orianbuilderAppId,
          };
          if (orianbuilderMentionedApps?.length) {
            parsedBody.orianbuilder_options.mentioned_apps =
              orianbuilderMentionedApps;
          }
        }

        // Return modified request with files included and requestId in headers
        const {
          [ORIANBUILDER_INTERNAL_REQUEST_ID_HEADER]: _,
          ...outgoingHeaders
        } = (init.headers as Record<string, string>) ?? {};
        const modifiedInit = {
          ...init,
          headers: {
            ...outgoingHeaders,
            ...(modifiedRequestId && {
              "X-OrianBuilder-Request-Id": modifiedRequestId,
            }),
          },
          body: JSON.stringify(parsedBody),
        };

        // Use the provided fetch or default fetch
        return (options.fetch || fetch)(input, modifiedInit);
      } catch (e) {
        logger.error("Error parsing request body", e);
        // If parsing fails, use original request
        return (options.fetch || fetch)(input, init);
      }
    };
  };

  const createChatModel = (
    modelId: ExampleChatModelId,
    chatParams: ChatParams,
  ) => {
    const config = {
      ...getCommonModelConfig(),
      fetch: createOrianBuilderFetch({ providerId: chatParams.providerId }),
    };

    return new OpenAICompatibleChatLanguageModel(modelId, config);
  };

  const createResponsesModel = (
    modelId: ExampleChatModelId,
    chatParams: ChatParams,
  ) => {
    const config = {
      ...getCommonModelConfig(),
      fetch: createOrianBuilderFetch({ providerId: chatParams.providerId }),
    };

    return new OpenAIResponsesLanguageModel(modelId, config);
  };

  const provider = (modelId: ExampleChatModelId, chatParams: ChatParams) =>
    createChatModel(modelId, chatParams);

  provider.chatModel = createChatModel;
  provider.responses = createResponsesModel;

  return provider;
}

export async function transcribeWithOrianBuilderEngine(
  audioBuffer: Buffer,
  filename: string,
  requestId: string,
  options: ExampleProviderSettings,
): Promise<string> {
  const baseURL = withoutTrailingSlash(options.baseURL);
  const apiKey = loadApiKey({
    apiKey: options.apiKey,
    environmentVariableName: "ORIANBUILDER_PRO_API_KEY",
    description: "OrianBuilder Pro API key",
  });
  logger.info("transcribing with orianbuilder engine with baseURL", baseURL);

  const formData = new FormData();
  const mimeType = filename.endsWith(".webm")
    ? "audio/webm"
    : filename.endsWith(".mp3")
      ? "audio/mpeg"
      : filename.endsWith(".wav")
        ? "audio/wav"
        : filename.endsWith(".m4a")
          ? "audio/mp4"
          : "audio/webm";
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
  formData.append("file", blob, filename);
  formData.append("model", "gpt-4o-mini-transcribe");

  const fetchFn = options.fetch || fetch;
  const response = await fetchFn(`${baseURL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-OrianBuilder-Request-Id": requestId,
      ...options.headers,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new OrianBuilderError(
      `OrianBuilder Engine transcription failed: ${response.status} ${response.statusText} - ${errorText}`,
      OrianBuilderErrorKind.External,
    );
  }
  const data = (await response.json()) as { text: string };
  return data.text;
}
