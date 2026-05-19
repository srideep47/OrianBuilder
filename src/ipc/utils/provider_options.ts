import type { SmartContextMode, UserSettings } from "../../lib/schemas";
import type { CodebaseFile } from "../../utils/codebase";
import type { VersionedFiles } from "./versioned_codebase_context";
import { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import { getExtraProviderOptions } from "./thinking_utils";
import type { JSONObject, JSONValue } from "@ai-sdk/provider";
import type { ProviderOptions } from "@ai-sdk/provider-utils";

export interface MentionedAppCodebase {
  appName: string;
  files: CodebaseFile[];
}

export interface GetProviderOptionsParams {
  orianbuilderAppId: number;
  orianbuilderRequestId?: string;
  orianbuilderDisableFiles?: boolean;
  smartContextMode?: SmartContextMode;
  files: CodebaseFile[];
  versionedFiles?: VersionedFiles;
  mentionedAppsCodebases: MentionedAppCodebase[];
  builtinProviderId: string | undefined;
  settings: UserSettings;
}

/**
 * Builds provider options for the AI SDK streamText call.
 * Handles provider-specific configuration including thinking configs for Google/Vertex.
 */
export function getProviderOptions({
  orianbuilderAppId,
  orianbuilderRequestId,
  orianbuilderDisableFiles,
  smartContextMode,
  files,
  versionedFiles,
  mentionedAppsCodebases,
  builtinProviderId,
  settings,
}: GetProviderOptionsParams): ProviderOptions {
  const engineOptions: JSONObject = {
    orianbuilderAppId,
    orianbuilderMentionedApps: mentionedAppsCodebases.map(
      ({ files, appName }) => ({
        appName,
        files,
      }),
    ) as unknown as JSONValue,
  };

  if (orianbuilderRequestId !== undefined) {
    engineOptions.orianbuilderRequestId = orianbuilderRequestId;
  }
  if (orianbuilderDisableFiles !== undefined) {
    engineOptions.orianbuilderDisableFiles = orianbuilderDisableFiles;
  }
  if (smartContextMode !== undefined) {
    engineOptions.orianbuilderSmartContextMode = smartContextMode;
  }
  if (versionedFiles) {
    engineOptions.orianbuilderVersionedFiles =
      versionedFiles as unknown as JSONValue;
  } else {
    engineOptions.orianbuilderFiles = files as unknown as JSONValue;
  }

  const openAIOptions = {
    reasoningSummary: "auto",
  } satisfies OpenAIResponsesProviderOptions;

  const providerOptions: ProviderOptions = {
    "orianbuilder-engine": engineOptions,
    "orianbuilder-gateway": getExtraProviderOptions(
      builtinProviderId,
      settings,
    ),
    openai: openAIOptions as JSONObject,
  };

  // Conditionally include Google thinking config only for supported models
  const selectedModelName = settings.selectedModel.name || "";
  const providerId = builtinProviderId;
  const isVertex = providerId === "vertex";
  const isGoogle = providerId === "google";
  const isPartnerModel = selectedModelName.includes("/");
  const isGeminiModel = selectedModelName.startsWith("gemini");
  const isFlashLite = selectedModelName.includes("flash-lite");

  // Keep Google provider behavior unchanged: always include includeThoughts
  if (isGoogle) {
    const googleOptions = {
      thinkingConfig: {
        includeThoughts: true,
      },
    } satisfies GoogleGenerativeAIProviderOptions;
    providerOptions.google = googleOptions as JSONObject;
  }

  // Vertex-specific fix: only enable thinking on supported Gemini models
  if (isVertex && isGeminiModel && !isFlashLite && !isPartnerModel) {
    const googleOptions = {
      thinkingConfig: {
        includeThoughts: true,
      },
    } satisfies GoogleGenerativeAIProviderOptions;
    providerOptions.google = googleOptions as JSONObject;
  }

  return providerOptions;
}

// Header used to pass the request ID through AI SDK models that don't forward
// providerOptions into the request body (e.g. OpenAIResponsesLanguageModel).
export const ORIANBUILDER_INTERNAL_REQUEST_ID_HEADER =
  "x-orianbuilder-internal-request-id" as const;

export interface GetAiHeadersParams {
  builtinProviderId: string | undefined;
}

/**
 * Returns extra AI request headers for the provider (e.g. beta flags).
 * Currently none; reserved for future provider-specific headers.
 */
export function getAiHeaders(
  _params: GetAiHeadersParams,
): Record<string, string> | undefined {
  return undefined;
}
