/** On-demand large local reasoning model for Marta's difficult questions. */

import fs from "node:fs";
import path from "node:path";
import log from "electron-log";

import { getModelGate } from "@/main/flow/model_gate";
import { LlamaServerBackend } from "@/main/llm/llama_server_backend";
import { readSettings } from "@/main/settings";
import { getMartaModelsRoot } from "./marta_model_store";

const logger = log.scope("marta-big-brain");
const BIG_BRAIN_HOST = "127.0.0.1";
const BIG_BRAIN_PORT = 11_535;
const REQUEST_TIMEOUT_MS = 10 * 60_000;

export interface BigBrainCandidate {
  modelId: string;
  modelPath: string;
  vramMb: number;
}

function configuredGpuLayers(candidate: BigBrainCandidate): number | null {
  try {
    const value = readSettings().embeddedConfig;
    if (!value || typeof value !== "object") return null;
    const embedded = value as Record<string, unknown>;
    if (
      embedded.modelPath === candidate.modelPath &&
      embedded.gpuLayersMode === "manual" &&
      typeof embedded.manualGpuLayers === "number" &&
      embedded.manualGpuLayers > 0
    ) {
      return embedded.manualGpuLayers;
    }
  } catch {
    // Settings are optional here; CPU fallback remains available.
  }
  return null;
}

function configuredCandidate(): BigBrainCandidate | null {
  const configured = process.env.ORIANBUILDER_BIG_BRAIN_MODEL;
  if (!configured || !fs.existsSync(configured)) return null;
  return {
    modelId: path.basename(configured, path.extname(configured)),
    modelPath: configured,
    vramMb: 24_000,
  };
}

/** Prefer the sparse 35B-A3B model, then the dense 27B fallback. */
export function findBigBrainModel(): BigBrainCandidate | null {
  const configured = configuredCandidate();
  if (configured) return configured;

  const roots = [
    process.platform === "win32"
      ? "D:\\AI models\\models\\lmstudio-community"
      : "",
    path.join(getMartaModelsRoot(), "brains"),
  ].filter(Boolean);
  const models = [
    {
      dir: "Qwen3.6-35B-A3B-GGUF",
      file: "Qwen3.6-35B-A3B-Q4_K_M.gguf",
      vramMb: 24_000,
    },
    {
      dir: "Qwen3.6-27B-GGUF",
      file: "Qwen3.6-27B-Q4_K_M.gguf",
      vramMb: 18_500,
    },
  ];
  for (const root of roots) {
    for (const model of models) {
      const modelPath = path.join(root, model.dir, model.file);
      if (fs.existsSync(modelPath)) {
        return {
          modelId: path.basename(model.file, ".gguf"),
          modelPath,
          vramMb: model.vramMb,
        };
      }
    }
  }
  return null;
}

async function complete(
  backend: LlamaServerBackend,
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const response = await fetch(
      `http://${BIG_BRAIN_HOST}:${BIG_BRAIN_PORT}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content:
                "You are Marta's private reasoning brain. Solve the difficult part precisely. Return a concise factual answer for Marta to relay. Do not claim to have run tools, changed files, or searched the web.",
            },
            { role: "user", content: question },
          ],
          temperature: 0.25,
          max_tokens: 2_048,
          stream: false,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(
        `Big brain returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) throw new Error("Big brain returned an empty answer.");
    return answer;
  } finally {
    clearTimeout(timeout);
  }
}

export async function askBigBrain(
  question: string,
  signal?: AbortSignal,
): Promise<{
  modelId: string;
  answer: string;
  placement: "gpu" | "hybrid" | "cpu";
}> {
  const candidate = findBigBrainModel();
  if (!candidate) {
    throw new Error(
      "No big-brain GGUF was found. Set ORIANBUILDER_BIG_BRAIN_MODEL or install Qwen3.6-35B-A3B under the local LM Studio model folder.",
    );
  }

  return getModelGate().withExternal(
    {
      kind: "llm",
      modelId: `brain:${candidate.modelId}`,
      vramMb: candidate.vramMb,
    },
    async () => {
      const backend = new LlamaServerBackend();
      const manualGpuLayers = configuredGpuLayers(candidate);
      let placement: "gpu" | "hybrid" | "cpu" = manualGpuLayers
        ? "hybrid"
        : "gpu";
      try {
        try {
          await backend.start({
            modelPath: candidate.modelPath,
            host: BIG_BRAIN_HOST,
            port: BIG_BRAIN_PORT,
            contextSize: 16_384,
            parallelSlots: 1,
            flashAttention: true,
            cacheTypeK: "q8_0",
            cacheTypeV: "q8_0",
            ...(manualGpuLayers
              ? {
                  gpuLayersMode: "manual" as const,
                  manualGpuLayers,
                }
              : {}),
            telemetry: false,
          });
        } catch (gpuError) {
          logger.warn("GPU big-brain launch failed; retrying on CPU", gpuError);
          placement = "cpu";
          await backend.start({
            modelPath: candidate.modelPath,
            host: BIG_BRAIN_HOST,
            port: BIG_BRAIN_PORT,
            contextSize: 8_192,
            parallelSlots: 1,
            gpuLayersMode: "manual",
            manualGpuLayers: 0,
            telemetry: false,
          });
        }
        return {
          modelId: candidate.modelId,
          answer: await complete(backend, question, signal),
          placement,
        };
      } finally {
        await backend.stop().catch(() => undefined);
      }
    },
  );
}
