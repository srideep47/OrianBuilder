import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import type { LanguageModelProvider } from "@/ipc/types";
import log from "electron-log";

import type { LargeLanguageModel, UserSettings } from "../../lib/schemas";
import { FREE_OPENROUTER_MODEL_NAMES } from "../shared/language_model_constants";
import { getLanguageModelProviders } from "../shared/language_model_helpers";
import { resolveBuiltinModelAlias } from "../shared/remote_language_model_catalog";
import { createFallback } from "./fallback_ai_model";
import {
  createOrianBuilderEngine,
  type OrianBuilderEngineProvider,
} from "./llm_engine_provider";
import { getModelProvider } from "./providers";
import { remotePeerProvider } from "./providers/RemotePeerProvider";
import type { ModelClient } from "./providers";
import { getEnvVar } from "./read_env";
import { getComputeTarget } from "@/main/compute/routing";

export type { ModelClient } from "./providers";

const orianbuilderEngineUrl = process.env.ORIANBUILDER_ENGINE_URL;

const AUTO_MODEL_ALIASES = [
  "orianbuilder/auto/openai",
  "orianbuilder/auto/anthropic",
  "orianbuilder/auto/google",
] as const;

const logger = log.scope("getModelClient");

// Local providers that benefit from remote GPU routing
const LOCAL_PROVIDERS = new Set(["embedded", "ollama", "lmstudio"]);

export async function getModelClient(
  model: LargeLanguageModel,
  settings: UserSettings,
): Promise<{
  modelClient: ModelClient;
  isEngineEnabled?: boolean;
  isSmartContextEnabled?: boolean;
}> {
  // ── Remote Compute Routing ─────────────────────────────────────────────────
  // When a peer's GPU is selected as the compute target and the user is running
  // a local model, route the inference through the P2P proxy (port 11436).
  // For any local provider (embedded / Ollama / LM Studio) we redirect.
  const computeTarget = getComputeTarget();
  if (
    computeTarget.mode === "peer" &&
    computeTarget.peerId &&
    LOCAL_PROVIDERS.has(model.provider)
  ) {
    const { networkSwarm } = await import("@/main/network/swarm");
    if (!networkSwarm.isPeerConnected(computeTarget.peerId)) {
      logger.warn(
        `[remote-compute] Selected peer ${computeTarget.peerId.slice(0, 16)}… is offline — falling back to local inference`,
      );
    } else {
      logger.info(
        `\x1b[1;30;46m[remote-compute] Routing ${model.provider}:${model.name} → peer ${computeTarget.peerId.slice(0, 16)}… via proxy:11436 \x1b[0m`,
      );
      return {
        modelClient: remotePeerProvider.createClient({
          model,
          settings,
          providerConfig: { id: "remote-peer", type: "builtin" } as any,
          apiKey: undefined,
          providerId: "remote-peer",
        }),
        isEngineEnabled: false,
      };
    }
  }

  const allProviders = await getLanguageModelProviders();

  const orianbuilderApiKey = settings.providerSettings?.auto?.apiKey?.value;

  const providerConfig = allProviders.find((p) => p.id === model.provider);

  if (!providerConfig) {
    throw new OrianBuilderError(
      `Configuration not found for provider: ${model.provider}`,
      OrianBuilderErrorKind.NotFound,
    );
  }

  if (orianbuilderApiKey && settings.enableOrianBuilderPro) {
    // Some providers like OpenAI have an empty string gateway prefix, so use a
    // nullish check instead of a truthy check.
    if (providerConfig.gatewayPrefix != null || orianbuilderEngineUrl) {
      const enableSmartFilesContext = settings.enableProSmartFilesContextMode;
      const provider = createOrianBuilderEngine({
        apiKey: orianbuilderApiKey,
        baseURL: orianbuilderEngineUrl ?? "https://engine.orianbuilder.sh/v1",
        orianbuilderOptions: {
          enableLazyEdits:
            settings.selectedChatMode === "ask"
              ? false
              : settings.enableProLazyEditsMode &&
                settings.proLazyEditsMode !== "v2",
          enableSmartFilesContext,
          enableWebSearch: settings.enableProWebSearch,
        },
        settings,
      });

      logger.info(
        `\x1b[1;97;44m Using OrianBuilder Pro API key for model: ${model.name} \x1b[0m`,
      );

      logger.info(
        `\x1b[1;30;42m Using OrianBuilder Pro engine: ${orianbuilderEngineUrl ?? "<prod>"} \x1b[0m`,
      );

      const modelName = model.name.split(":free")[0];
      const proModelClient = await getProModelClient({
        model,
        settings,
        provider,
        modelId: `${providerConfig.gatewayPrefix || ""}${modelName}`,
      });

      return {
        modelClient: proModelClient,
        isEngineEnabled: true,
        isSmartContextEnabled: enableSmartFilesContext,
      };
    }

    logger.warn(
      `OrianBuilder Pro enabled, but provider ${model.provider} does not have a gateway prefix defined. Falling back to direct provider connection.`,
    );
  }

  if (model.provider === "auto") {
    if (model.name === "free") {
      const openRouterProvider = allProviders.find(
        (p) => p.id === "openrouter",
      );
      if (!openRouterProvider) {
        throw new OrianBuilderError(
          "OpenRouter provider not found",
          OrianBuilderErrorKind.NotFound,
        );
      }
      return {
        modelClient: {
          model: createFallback({
            models: FREE_OPENROUTER_MODEL_NAMES.map(
              (name: string) =>
                getRegularModelClient(
                  { provider: "openrouter", name },
                  settings,
                  openRouterProvider,
                ).modelClient.model,
            ),
          }),
          builtinProviderId: "openrouter",
        },
        isEngineEnabled: false,
      };
    }

    for (const autoModelAlias of AUTO_MODEL_ALIASES) {
      const resolvedModel = await resolveBuiltinModelAlias(autoModelAlias);
      if (!resolvedModel) {
        continue;
      }

      const providerInfo = allProviders.find(
        (p) => p.id === resolvedModel.providerId,
      );
      const envVarName = providerInfo?.envVarName;

      const apiKey =
        settings.providerSettings?.[resolvedModel.providerId]?.apiKey?.value ||
        (envVarName ? getEnvVar(envVarName) : undefined);

      if (apiKey) {
        logger.log(
          `Using provider: ${resolvedModel.providerId} model: ${resolvedModel.apiName}`,
        );
        return await getModelClient(
          {
            provider: resolvedModel.providerId,
            name: resolvedModel.apiName,
          },
          settings,
        );
      }
    }

    throw new Error(
      "No API keys available for any model supported by the 'auto' provider.",
    );
  }

  return getRegularModelClient(model, settings, providerConfig);
}

async function getProModelClient({
  model,
  settings,
  provider,
  modelId,
}: {
  model: LargeLanguageModel;
  settings: UserSettings;
  provider: OrianBuilderEngineProvider;
  modelId: string;
}): Promise<ModelClient> {
  if (
    settings.selectedChatMode === "local-agent" &&
    model.provider === "auto" &&
    model.name === "auto"
  ) {
    const providers = await getLanguageModelProviders();
    const fallbackModels = await Promise.all(
      AUTO_MODEL_ALIASES.map(async (aliasId) => {
        const resolvedModel = await resolveBuiltinModelAlias(aliasId);
        if (!resolvedModel) {
          return null;
        }

        const resolvedProvider = providers.find(
          (providerInfo) => providerInfo.id === resolvedModel.providerId,
        );
        const resolvedModelId = `${
          resolvedProvider?.gatewayPrefix || ""
        }${resolvedModel.apiName}`;

        if (resolvedModel.providerId === "openai") {
          return provider.responses(resolvedModel.apiName, {
            providerId: resolvedModel.providerId,
          });
        }

        return provider(resolvedModelId, {
          providerId: resolvedModel.providerId,
        });
      }),
    );

    const validModels = fallbackModels.filter(
      (candidate) => candidate !== null,
    );
    if (validModels.length === 0) {
      throw new OrianBuilderError(
        "No auto-mode models could be resolved from the catalog",
        OrianBuilderErrorKind.External,
      );
    }

    return {
      // We need to do the fallback here (and not server-side) because GPT-5*
      // models need responses API support for full functionality.
      model: createFallback({
        models: validModels,
      }),
    };
  }

  if (
    settings.selectedChatMode === "local-agent" &&
    model.provider === "openai"
  ) {
    return {
      model: provider.responses(modelId, { providerId: model.provider }),
      builtinProviderId: model.provider,
    };
  }

  return {
    model: provider(modelId, { providerId: model.provider }),
    builtinProviderId: model.provider,
  };
}

function getRegularModelClient(
  model: LargeLanguageModel,
  settings: UserSettings,
  providerConfig: LanguageModelProvider,
): {
  modelClient: ModelClient;
  backupModelClients: ModelClient[];
} {
  const apiKey =
    settings.providerSettings?.[model.provider]?.apiKey?.value ||
    (providerConfig.envVarName
      ? getEnvVar(providerConfig.envVarName)
      : undefined);

  const providerId = providerConfig.id;
  const provider = getModelProvider(providerConfig);

  if (!provider) {
    throw new OrianBuilderError(
      `Unsupported model provider: ${model.provider}`,
      OrianBuilderErrorKind.Validation,
    );
  }

  return {
    modelClient: provider.createClient({
      model,
      settings,
      providerConfig,
      apiKey,
      providerId,
    }),
    backupModelClients: [],
  };
}
