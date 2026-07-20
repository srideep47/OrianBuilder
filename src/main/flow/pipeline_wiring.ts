import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { generateText } from "ai";
import log from "electron-log";
import { readSettings } from "@/main/settings";
import { getModelClient } from "@/ipc/utils/get_model_client";
import {
  getProviderOptions,
  getAiHeaders,
  ORIANBUILDER_INTERNAL_REQUEST_ID_HEADER,
} from "@/ipc/utils/provider_options";
import { getServerStatus } from "@/ipc/utils/embedded_inference_server";
import { getOrchestrator } from "@/main/ipc/utils/model_orchestrator";
import {
  MEDIA_AI_SERVER_URL,
  isMediaAiBackendHealthy,
  releaseAllMediaAiModels,
  startMediaAiBackend,
} from "@/ipc/utils/media_ai_backend";
import { getModelGate, type ResidentSlot } from "./model_gate";
import type { GenerateTextFn } from "./asset_planner";
import type { ThreeDGenerator } from "./asset_worker";

// =============================================================================
// Orion Orchestrated Pipeline — Real-backend wiring
// =============================================================================
//
// Connects the pure pipeline core to the live app: the multimodal LLM (via the
// model client), the embedded inference server (for the ModelGate's LLM
// load/unload), and the Media AI backend (for 3D / TripoSR).
//
// The Media AI backend loads models on demand. The gate calls its unload API at
// every media boundary so only the model required by the current planned stage
// can be resident. If cooperative unload fails, it stops the Python process as
// a hard fallback before another model is allowed to load.
// See plans/orion-orchestrated-pipeline.md.
// =============================================================================

const logger = log.scope("pipeline-wiring");

// ─── LLM text generation (Phase A planner / Phase C verify) ──────────────────

/**
 * Real `GenerateTextFn` backed by the user's selected model. Mirrors the call
 * shape used by `intent_parser.ts`. Multimodal models are required by the
 * pipeline; this text path is used for planning (vision verify is a later add).
 */
export const defaultGenerateText: GenerateTextFn = async ({
  system,
  prompt,
}) => {
  const settings = readSettings();
  const { modelClient } = await getModelClient(
    settings.selectedModel,
    settings,
  );
  const requestId = crypto.randomUUID();
  const { text } = await generateText({
    model: modelClient.model,
    headers: {
      ...getAiHeaders({ builtinProviderId: modelClient.builtinProviderId }),
      [ORIANBUILDER_INTERNAL_REQUEST_ID_HEADER]: requestId,
    },
    providerOptions: getProviderOptions({
      orianbuilderAppId: 0,
      orianbuilderRequestId: requestId,
      orianbuilderDisableFiles: true,
      files: [],
      mentionedAppsCodebases: [],
      builtinProviderId: modelClient.builtinProviderId,
      settings,
    }),
    system,
    prompt,
    maxRetries: 2,
  });
  return text;
};

// ─── Last-loaded LLM identity (for gate no-op detection) ─────────────────────

export function getLastLlmModelId(): string {
  const status = getServerStatus();
  return status.modelPath
    ? (status.modelPath.split(/[/\\]/).pop() ?? "llm")
    : "llm";
}

// ─── ModelGate hooks ─────────────────────────────────────────────────────────

let gateConfigured = false;

/**
 * Wire the single-resident ModelGate to real load/unload:
 *  - kind "llm"  → the orchestrator's LLM lifecycle (`acquireLlm`/`releaseAll`),
 *    whose hooks `embedded_model_handler` already binds to the *enriched* real
 *    load path (`loadModelFromConfig`) + `unloadModel`. We reuse that rather
 *    than calling `loadModel` with a possibly-incomplete saved config.
 *  - media kinds → keep the Python service warm, but unload all model weights
 *    at stage boundaries. Process stop remains the hard fallback.
 * Idempotent.
 */
export function configureModelGateHooks(): void {
  if (gateConfigured) return;
  gateConfigured = true;

  getModelGate().setHooks({
    load: async (slot: ResidentSlot) => {
      if (slot.kind === "llm") {
        const status = getServerStatus();
        if (status.modelPath) {
          // Engine already holds a model — adopt it, no reload.
          getOrchestrator().informLlmAcquired({
            modelPath: status.modelPath,
            gpuLayers: status.gpuLayers ?? 0,
            contextSize: status.actualContextSize ?? 4096,
          });
          return;
        }
        // Nothing loaded → reload from saved config via the orchestrator's
        // reloadLlm hook (wired in embedded_model_handler).
        logger.info(`gate: reloading LLM ${slot.modelId}`);
        const cfg = (
          readSettings() as { embeddedConfig?: { modelPath?: string } }
        ).embeddedConfig;
        await getOrchestrator().acquireLlm({
          modelPath: cfg?.modelPath ?? slot.modelId,
          gpuLayers: 0,
          contextSize: 4096,
        });
      } else {
        // A model may have been loaded through another surface before this
        // planned pipeline started. Clear it before the worker lazily loads
        // the exact model selected for this stage.
        logger.info(
          `gate: preparing exclusive media slot ${slot.kind}:${slot.modelId}`,
        );
        const serverStatus = getServerStatus();
        const orchestratorStatus = getOrchestrator().getStatus();
        if (
          serverStatus.modelPath ||
          orchestratorStatus.currentLlmModel != null
        ) {
          logger.info("gate: releasing an externally-loaded LLM before media");
          await getOrchestrator().releaseAll();
        }
        await ensureMediaBackendHealthy();
        await releaseAllMediaAiModels();
        // The strict fallback stops the backend. Bring the lightweight service
        // back without loading weights so the requested media stage can run.
        await ensureMediaBackendHealthy();
      }
    },
    unload: async (slot: ResidentSlot) => {
      if (slot.kind === "llm") {
        logger.info(`gate: unloading LLM ${slot.modelId}`);
        await getOrchestrator().releaseAll();
      } else {
        logger.info(`gate: unloading media slot ${slot.kind}:${slot.modelId}`);
        await releaseAllMediaAiModels();
      }
    },
  });
}

/** Start the media backend (if not running) and wait until it is healthy.
 *  Used by the gate's media load hook because we stop the backend between
 *  modalities to free VRAM. Mirrors the flow handler's readiness wait. */
async function ensureMediaBackendHealthy(): Promise<void> {
  if (await isMediaAiBackendHealthy()) return;
  await startMediaAiBackend();
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (await isMediaAiBackendHealthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  logger.warn("media backend did not become healthy within 30s");
}

// ─── 3D generator (TripoSR via the Media AI backend) ─────────────────────────

/**
 * Real `ThreeDGenerator`: posts a reference image to the Media AI backend's
 * `/v1/generate/3d` endpoint (TripoSR) and writes the returned GLB to
 * `outputPath`. Returns success:false (not throw) on any failure so the asset
 * is marked failed without blocking the build.
 */
export const backendThreeDGenerator: ThreeDGenerator = async ({
  refImagePath,
  outputPath,
  settings,
}) => {
  if (!refImagePath) {
    return { success: false, error: "3d asset has no reference image" };
  }
  if (!(await isMediaAiBackendHealthy())) {
    return { success: false, error: "media backend not healthy" };
  }
  try {
    const imageBytes = await fs.readFile(refImagePath);
    const ab = imageBytes.buffer.slice(
      imageBytes.byteOffset,
      imageBytes.byteOffset + imageBytes.byteLength,
    ) as ArrayBuffer;
    const form = new FormData();
    form.append(
      "image",
      new Blob([ab]),
      path.basename(refImagePath) || "reference.png",
    );
    form.append(
      "mesh_resolution",
      String((settings.mesh_resolution as number) ?? 192),
    );
    form.append(
      "foreground_ratio",
      String((settings.foreground_ratio as number) ?? 0.85),
    );

    const res = await fetch(`${MEDIA_AI_SERVER_URL}/v1/generate/3d`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!res.ok) {
      return {
        success: false,
        error: (await res.text().catch(() => "")) || `HTTP ${res.status}`,
      };
    }
    const mesh = (await res.json()) as { model_url: string };
    const glb = await fetch(`${MEDIA_AI_SERVER_URL}${mesh.model_url}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!glb.ok) {
      return { success: false, error: `fetch GLB failed: ${glb.status}` };
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, Buffer.from(await glb.arrayBuffer()));
    return { success: true, outputPath };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
