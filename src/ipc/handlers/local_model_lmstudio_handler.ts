import log from "electron-log";
import { LM_STUDIO_BASE_URL } from "../utils/lm_studio_utils";
import { createTypedHandler } from "./base";
import { languageModelContracts } from "../types/language-model";
import type { LocalModel } from "../types/language-model";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

const logger = log.scope("lmstudio_handler");

export interface LMStudioModel {
  type: "llm" | "vlm" | "embeddings" | string;
  id: string;
  object: string;
  publisher: string;
  state: "loaded" | "not-loaded";
  max_context_length: number;
  quantization: string;
  compatibility_type: string;
  arch: string;
  [key: string]: any;
}

const NON_CHAT_MODEL_TYPES = new Set(["embeddings", "embedding"]);

export async function fetchLMStudioModels(): Promise<{ models: LocalModel[] }> {
  const modelsResponse: Response = await fetch(
    `${LM_STUDIO_BASE_URL}/api/v0/models`,
  );
  if (!modelsResponse.ok) {
    throw new DyadError(
      "Failed to fetch models from LM Studio",
      DyadErrorKind.External,
    );
  }
  const modelsJson = await modelsResponse.json();
  const downloadedModels = modelsJson.data as LMStudioModel[];
  const models: LocalModel[] = downloadedModels
    .filter((model: any) => !NON_CHAT_MODEL_TYPES.has(model.type))
    .map((model: any) => ({
      modelName: model.id,
      displayName: model.id,
      provider: "lmstudio",
    }));

  logger.info(`Successfully fetched ${models.length} models from LM Studio`);
  return { models };
}

/**
 * Returns the actual loaded context length for the given LM Studio model.
 * Falls back to max_context_length, then undefined if the model isn't found.
 */
export async function getLMStudioContextWindow(
  modelName: string,
): Promise<number | undefined> {
  try {
    const res = await fetch(`${LM_STUDIO_BASE_URL}/api/v0/models`);
    if (!res.ok) return undefined;
    const json = await res.json();
    const model = (json.data as LMStudioModel[]).find(
      (m) => m.id === modelName,
    );
    if (!model) return undefined;
    // loaded_context_length is what actually limits inference
    return model.loaded_context_length ?? model.max_context_length ?? undefined;
  } catch {
    return undefined;
  }
}

export function registerLMStudioHandlers() {
  createTypedHandler(languageModelContracts.listLMStudioModels, async () => {
    return fetchLMStudioModels();
  });
}
