/**
 * Embedded local inference server.
 *
 * Two backend variants live behind a single port (EMBEDDED_PORT = 11435) so
 * LocalLlamaProvider can hit one base URL regardless of which engine is active:
 *
 *   1. "llama-cpp"     → spawns `llama-server` (llama.cpp's native HTTP server)
 *                        as a child process. That process itself binds 11435
 *                        and serves the OpenAI-compatible /v1/* surface — no
 *                        in-process inference happens here anymore.
 *
 *   2. "tensorrt-native" → runs inside our process via TensorRtNativeBackend.
 *                        Since TensorRT has no built-in HTTP API, we expose
 *                        it through a small http.Server that listens on
 *                        EMBEDDED_PORT and forwards requests into the backend.
 *
 * Exactly one of the two owns EMBEDDED_PORT at any time; switching backends
 * goes through _fullReset() which tears both down before starting the new one.
 *
 * The previous implementation used node-llama-cpp bindings in-process via a
 * 1000-line custom /v1/chat/completions handler. Moving inference into the
 * native llama-server binary removes the JS hot path and gives us llama.cpp's
 * full performance directly.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";
import log from "electron-log";

import {
  findDefaultTensorRtEngineDir,
  TensorRtNativeBackend,
} from "./tensorrt_native_backend";
import { embeddedModelEvents } from "../types/embedded_model";
import { safeSend } from "./safe_sender";
import { getCachedHardwareProfile } from "@/main/hardware/detect";
import {
  resolveLlmBackendOptions,
  getLlmBackendName,
} from "@/main/llm/backend_resolver";
import {
  openAiToPlainPrompt,
  createThinkingStripper,
  stripThinkingBlocks,
  estimateOpenAIRequestTokens,
  sseChunk,
  type OpenAIMessage,
} from "./inference/message_converter";
import {
  statsTracker,
  type InferenceState,
  type InferenceStats,
  type InferenceLogEntry,
} from "./inference/stats_tracker";
import { LlamaServerBackend } from "@/main/llm/llama_server_backend";

export type { InferenceState, InferenceStats, InferenceLogEntry };

const logger = log.scope("embedded-inference");

export const EMBEDDED_PORT = 11435;
export const EMBEDDED_BASE_URL = `http://127.0.0.1:${EMBEDDED_PORT}`;

// ─── Module state ────────────────────────────────────────────────────────────
// All mutations go through the helpers below (setIsInferring, _fullReset, etc.)
// so backend transitions stay observable. Reads/writes happen on the Node.js
// event loop (single-threaded), but async await points can interleave callers.

const llamaServerBackend = new LlamaServerBackend();
let tensorRtBackend: TensorRtNativeBackend | null = null;
let server: http.Server | null = null;
let currentBackend: "none" | "llama-cpp" | "tensorrt-native" = "none";
let currentModelPath: string | null = null;
let currentTotalLayers = 0;
let currentGpuLayers = 0;
let currentActualContextSize = 0;
let isLoading = false;
let isInferring = false;
/**
 * Wall-clock timestamp at which `isInferring` was most recently set to `true`.
 * Used by `forceReleaseIfStuck` to detect a stuck flag.
 */
let isInferringSetAtMs: number | null = null;
let currentAbort: AbortController | null = null;

type KvCacheType =
  | "f32"
  | "f16"
  | "bf16"
  | "q8_0"
  | "q5_0"
  | "q5_1"
  | "q4_0"
  | "q4_1";

export interface EmbeddedModelConfig {
  modelPath: string;
  inferenceBackend?: "llama-cpp" | "tensorrt-native";
  tensorRtEngineDir?: string | null;
  gpuMemoryUtilization: number;
  vramHeadroomMb?: number;
  contextSize: number;
  batchSize?: number;
  flashAttention?: boolean;
  aggressiveMemory?: boolean;
  gpuLayersMode?: "auto" | "manual";
  manualGpuLayers?: number | null;
  cacheTypeK?: KvCacheType;
  cacheTypeV?: KvCacheType;
  _estimatedLayers?: number;
  _layerSizeMb?: number;
  _vramMb?: number;
  _kvBytesPerTokenPerLayer?: number;
  _attentionSlidingWindow?: number | null;
  _attentionSlidingWindowPattern?: number | null;
}

let defaultSampling = {
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  repeatPenalty: 1.1,
  seed: undefined as number | undefined,
};

export function setDefaultSampling(s: Partial<typeof defaultSampling>): void {
  defaultSampling = { ...defaultSampling, ...s };
}

export interface EmbeddedServerStatus {
  running: boolean;
  modelLoaded: boolean;
  modelPath: string | null;
  modelName: string | null;
  /** True when the loaded model can accept image inputs (mmproj loaded for
   *  llama-server, or a multimodal TensorRT engine). Drives the agent's
   *  decision to forward screenshot content vs degrade to a text placeholder. */
  multimodal: boolean;
  isLoading: boolean;
  isInferring: boolean;
  backend: "none" | "llama-cpp" | "tensorrt-native";
  tensorRtRunnerAvailable: boolean;
  tensorRtRuntimeAvailable: boolean;
  tensorRtRuntimePath: string | null;
  tensorRtEngineDir: string | null;
  tensorRtEngineFormat: "tensorrt-llm" | "tensorrt-plan" | "unknown" | null;
  gpuLayers: number;
  totalLayers: number;
  cpuLayers: number;
  actualContextSize: number;
  chatWrapperLabel: string | null;
}

// ─── isInferring helpers ──────────────────────────────────────────────────────

function setIsInferring(value: boolean): void {
  isInferring = value;
  isInferringSetAtMs = value ? Date.now() : null;
}

/**
 * Detect a stuck `isInferring` flag and force-clear it. Safe to clear only
 * when the flag has been `true` for longer than `staleAfterMs` AND no abort
 * controller is active — meaning no real generation is running.
 */
function forceReleaseIfStuck(staleAfterMs: number = 2_000): boolean {
  if (!isInferring || isInferringSetAtMs === null) return false;
  const elapsed = Date.now() - isInferringSetAtMs;
  if (elapsed < staleAfterMs) return false;
  const realInferenceActive =
    currentAbort !== null && !(currentAbort as AbortController).signal.aborted;
  if (realInferenceActive) return false;
  logger.warn(
    `Detected stuck isInferring flag (held ${elapsed}ms with no active abort controller); force-clearing so the next caller can proceed`,
  );
  setIsInferring(false);
  return true;
}

export async function waitForInferenceFree(
  timeoutMs: number = 15_000,
): Promise<boolean> {
  if (!isInferring) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!isInferring) return true;
    forceReleaseIfStuck();
    if (!isInferring) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  forceReleaseIfStuck(0);
  return !isInferring;
}

// ─── Status ──────────────────────────────────────────────────────────────────

export function getServerStatus(): EmbeddedServerStatus {
  const tensorRtStatus = getTensorRtBackend().getStatus();
  const llamaServerStatus = llamaServerBackend.getStatus();
  const tensorRtLoaded =
    currentBackend === "tensorrt-native" && tensorRtStatus.loaded;
  const llamaLoaded =
    currentBackend === "llama-cpp" && llamaServerStatus.running;
  const gpuLayers =
    currentBackend === "llama-cpp"
      ? llamaServerStatus.resolvedGpuLayers
      : currentGpuLayers;
  const multimodal =
    currentBackend === "llama-cpp" && llamaServerStatus.mmprojPath !== null;
  return {
    running: server !== null || llamaServerStatus.running,
    modelLoaded: llamaLoaded || tensorRtLoaded,
    modelPath: currentModelPath,
    modelName: currentModelPath
      ? (currentModelPath.split(/[/\\]/).pop() ?? null)
      : null,
    multimodal,
    isLoading,
    isInferring,
    backend: currentBackend,
    tensorRtRunnerAvailable: tensorRtStatus.runnerAvailable,
    tensorRtRuntimeAvailable: tensorRtStatus.runtimeAvailable,
    tensorRtRuntimePath: tensorRtStatus.runtimePath,
    tensorRtEngineDir: tensorRtStatus.engineDir,
    tensorRtEngineFormat: tensorRtStatus.engineFormat,
    gpuLayers,
    totalLayers: currentTotalLayers,
    cpuLayers: Math.max(0, currentTotalLayers - gpuLayers),
    actualContextSize: currentActualContextSize,
    // The chat template is now resolved by llama-server from the GGUF's
    // embedded template (or --chat-template override). We no longer carry one
    // in-process, so this field stays null for the llama-cpp backend.
    chatWrapperLabel: null,
  };
}

function emitStatusChanged(): EmbeddedServerStatus {
  const status = getServerStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      safeSend(
        win.webContents,
        embeddedModelEvents.statusChanged.channel,
        status,
      );
    }
  }
  return status;
}

// ─── Public stats API (delegates to StatsTracker singleton) ──────────────────

export const addStatsListener =
  statsTracker.addStatsListener.bind(statsTracker);
export const addLogListener = statsTracker.addLogListener.bind(statsTracker);
export const getRecentLogs = statsTracker.getRecentLogs.bind(statsTracker);
export const getCurrentStats = statsTracker.getCurrentStats.bind(statsTracker);
export const startHardwareBroadcast =
  statsTracker.startHardwareBroadcast.bind(statsTracker);
export const stopHardwareBroadcast =
  statsTracker.stopHardwareBroadcast.bind(statsTracker);

// ─── Private stats shorthands (used inside the TensorRT handler below) ───────

const setState = statsTracker.setState.bind(statsTracker);
const beginSession = statsTracker.beginSession.bind(statsTracker);
const stopStatsBroadcast = statsTracker.stopStatsBroadcast.bind(statsTracker);
const recordToken = statsTracker.recordToken.bind(statsTracker);
const recordTokenCount = statsTracker.recordTokenCount.bind(statsTracker);

// ─── electron-log hook: mirror inference-scope logs into the ring buffer ──────

(logger as any).hooks = [
  ...((logger as any).hooks ?? []),
  (message: any) => {
    const level =
      message.level === "warn"
        ? "warn"
        : message.level === "error"
          ? "error"
          : "info";
    const text = message.data?.map(String).join(" ") ?? "";
    statsTracker.emitLog(level as InferenceLogEntry["level"], text);
    return message;
  },
];

// ─── TensorRT helpers ────────────────────────────────────────────────────────

function getTensorRtBackend(): TensorRtNativeBackend {
  tensorRtBackend ??= new TensorRtNativeBackend();
  return tensorRtBackend;
}

// ─── Sampling helpers (used by the TensorRT path only) ───────────────────────

function isQwen3Model(modelPath: string | null) {
  const filename = modelPath?.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  return /qwen[._-]?3/.test(filename) || filename.includes("qwen3");
}

function getModelFamilySamplingDefaults() {
  if (isQwen3Model(currentModelPath)) {
    return {
      ...defaultSampling,
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      repeatPenalty: 1.0,
    };
  }
  return defaultSampling;
}

function applyThinkingState(input: {
  enteredThinking: boolean;
  exitedThinking: boolean;
  generatingOperation: string;
}) {
  if (input.enteredThinking) {
    setState("thinking", "Thinking...");
    return;
  }
  if (
    input.exitedThinking ||
    statsTracker.getInferenceState() === "prefilling"
  ) {
    setState("generating", input.generatingOperation);
  }
}

// ─── Model loading ───────────────────────────────────────────────────────────

export async function loadModel(config: EmbeddedModelConfig): Promise<void> {
  if (isLoading) throw new Error("A model is already loading");
  isLoading = true;
  emitStatusChanged();

  try {
    if (config.inferenceBackend === "tensorrt-native") {
      await loadTensorRtModel(config);
    } else {
      await loadLlamaServerModel(config);
    }
  } finally {
    isLoading = false;
    emitStatusChanged();
  }
}

/**
 * Look for a multimodal projector (`mmproj-*.gguf`) sitting next to the main
 * model file. LM Studio and the lmstudio-community releases ship this as a
 * sibling of the GGUF weights, so a directory scan covers the common case.
 *
 * Returns the projector's absolute path, or null when no companion is found.
 */
function findCompanionMmproj(modelPath: string): string | null {
  try {
    const modelDir = path.dirname(modelPath);
    const modelName = path.basename(modelPath, ".gguf").toLowerCase();
    const candidates = fs
      .readdirSync(modelDir)
      .filter((name) => {
        const lower = name.toLowerCase();
        return (
          lower.endsWith(".gguf") &&
          (lower.startsWith("mmproj") || lower.includes("mmproj"))
        );
      })
      .map((name) => path.join(modelDir, name));
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    // When multiple mmproj variants share a directory (e.g. F16 + BF16 next
    // to the same weights), prefer the one whose filename mentions the
    // model name; otherwise fall back to the first.
    const matched = candidates.find((p) =>
      path.basename(p).toLowerCase().includes(modelName.split(/[.-]/)[0]),
    );
    return matched ?? candidates[0];
  } catch (err) {
    logger.warn("findCompanionMmproj failed:", err);
    return null;
  }
}

async function loadLlamaServerModel(
  config: EmbeddedModelConfig,
): Promise<void> {
  setState("loading", `Loading ${config.modelPath.split(/[/\\]/).pop()}…`);

  // Tear down anything currently bound to EMBEDDED_PORT before starting
  // llama-server, otherwise its bind() will EADDRINUSE.
  await _fullReset();

  const totalLayers = config._estimatedLayers ?? 64;

  // Honor the hardware profile's bestLlmBackend. CPU-only systems get
  // gpuLayers=0 regardless of GGUF math.
  let cpuOnly = false;
  let resolvedBackendLabel: string | null = null;
  try {
    const profile = await getCachedHardwareProfile();
    const opts = resolveLlmBackendOptions(profile);
    resolvedBackendLabel = getLlmBackendName(profile);
    if (opts.gpuLayers === 0) {
      cpuOnly = true;
    }
  } catch (err) {
    logger.warn(
      "resolveLlmBackendOptions failed; letting llama-server pick a backend:",
      err,
    );
  }

  const mmprojPath = findCompanionMmproj(config.modelPath);

  logger.info(
    `Loading: ${config.modelPath} | ctx=${config.contextSize} | ` +
      `gpuLayersMode=${config.gpuLayersMode ?? "auto"}` +
      (cpuOnly ? " (forced CPU)" : "") +
      (mmprojPath ? ` | mmproj=${path.basename(mmprojPath)}` : "") +
      (resolvedBackendLabel ? ` | backend=${resolvedBackendLabel}` : ""),
  );

  try {
    await llamaServerBackend.start({
      modelPath: config.modelPath,
      mmprojPath,
      port: EMBEDDED_PORT,
      contextSize: config.contextSize,
      batchSize: config.batchSize ?? 512,
      flashAttention: config.flashAttention ?? true,
      gpuLayersMode: cpuOnly ? "manual" : (config.gpuLayersMode ?? "auto"),
      manualGpuLayers: cpuOnly ? 0 : (config.manualGpuLayers ?? null),
      autoCompute: {
        vramMb: config._vramMb ?? 0,
        gpuMemoryUtilization: config.gpuMemoryUtilization,
        vramHeadroomMb: config.vramHeadroomMb,
        layerSizeMb: config._layerSizeMb ?? 200,
        totalLayers,
        kvBytesPerTokenPerLayer: config._kvBytesPerTokenPerLayer ?? 4096,
        attentionSlidingWindow: config._attentionSlidingWindow,
        attentionSlidingWindowPattern: config._attentionSlidingWindowPattern,
      },
      // --jinja enables OpenAI-format tool calling against the model's
      // GGUF-embedded chat template. Models that don't support tool roles
      // still fall back to the agent's text-tool-call extraction path.
      enableJinjaTools: true,
      // KV-cache quantization halves KV memory at ~negligible quality cost.
      // Requires --flash-attn=on, which is already our default above. Anyone
      // who needs unquantized cache can pass cacheTypeK/V="f16" in the config.
      cacheTypeK: config.cacheTypeK ?? "q8_0",
      cacheTypeV: config.cacheTypeV ?? "q8_0",
    });

    currentBackend = "llama-cpp";
    statsTracker.setBackend("llama-cpp");
    currentModelPath = config.modelPath;
    currentTotalLayers = totalLayers;
    currentGpuLayers = llamaServerBackend.getStatus().resolvedGpuLayers;
    currentActualContextSize = config.contextSize;
    setState("idle", "Model ready");
    emitStatusChanged();
  } catch (err) {
    currentBackend = "none";
    statsTracker.setBackend("none");
    currentModelPath = null;
    currentTotalLayers = 0;
    currentGpuLayers = 0;
    currentActualContextSize = 0;
    setState("idle", "");
    emitStatusChanged();
    throw err;
  }
}

async function loadTensorRtModel(config: EmbeddedModelConfig): Promise<void> {
  const engineDir = config.tensorRtEngineDir ?? findDefaultTensorRtEngineDir();
  if (!engineDir) {
    currentBackend = "none";
    statsTracker.setBackend("none");
    emitStatusChanged();
    throw new Error(
      "TensorRT engine directory not found. Select a compiled engine directory containing engine_meta.json.",
    );
  }

  setState("loading", `Loading TensorRT engine ${engineDir}...`);
  await _fullReset();
  currentBackend = "tensorrt-native";
  statsTracker.setBackend("tensorrt-native");
  try {
    await getTensorRtBackend().load(engineDir);
    currentModelPath = engineDir;
    currentGpuLayers = config._estimatedLayers ?? 0;
    currentTotalLayers = config._estimatedLayers ?? 0;
    currentActualContextSize = config.contextSize;
    // Bind our TensorRT-only HTTP server. Has to happen AFTER llama-server is
    // stopped (in _fullReset) so EMBEDDED_PORT is free.
    await ensureTensorRtServerListening();
    setState("idle", "TensorRT engine ready");
    emitStatusChanged();
  } catch (err) {
    currentBackend = "none";
    statsTracker.setBackend("none");
    currentModelPath = null;
    currentGpuLayers = 0;
    currentTotalLayers = 0;
    currentActualContextSize = 0;
    emitStatusChanged();
    throw err;
  }
}

async function _fullReset(): Promise<void> {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }
  setIsInferring(false);
  await llamaServerBackend.stop();
  await stopTensorRtServer();
  await tensorRtBackend?.unload();
  currentModelPath = null;
  currentBackend = "none";
  statsTracker.setBackend("none");
  currentGpuLayers = 0;
  currentTotalLayers = 0;
  currentActualContextSize = 0;
  emitStatusChanged();
}

export async function unloadModel(): Promise<void> {
  await _fullReset();
  logger.info("Model unloaded");
  emitStatusChanged();
}

export function abortCurrentInference(): void {
  if (currentAbort && !currentAbort.signal.aborted) {
    currentAbort.abort();
  }
  currentAbort = null;
  setIsInferring(false);
  emitStatusChanged();
  logger.info("Inference aborted by caller");
}

// ─── TensorRT inference handler ──────────────────────────────────────────────
// Only reached when the TensorRT-native backend is loaded. The llama-cpp
// backend never enters our HTTP server — llama-server handles requests itself.

async function handleTensorRtChatCompletions(
  rawMessages: OpenAIMessage[],
  payload: any,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqId: string,
  created: number,
  modelName: string,
): Promise<void> {
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message:
            "Native TensorRT backend does not support tool calling yet. Use llama.cpp backend for app-building agent mode.",
          type: "unsupported_tools",
        },
      }),
    );
    return;
  }

  if (isInferring) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "Inference busy — one request at a time",
          type: "busy",
        },
      }),
    );
    return;
  }

  const stream: boolean = payload.stream ?? false;
  const maxTokens: number = payload.max_tokens ?? 8192;
  const { system, prompt } = openAiToPlainPrompt(rawMessages);
  const estimatedInputTokens = estimateOpenAIRequestTokens(rawMessages);

  setIsInferring(true);
  emitStatusChanged();
  const abort = new AbortController();
  currentAbort = abort;
  req.on("close", () => {
    if (!abort.signal.aborted) abort.abort();
  });

  beginSession(estimatedInputTokens);
  setState("prefilling", "TensorRT prefill…");

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(
      sseChunk({
        id: reqId,
        object: "chat.completion.chunk",
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      }),
    );
  }

  try {
    const samplingDefaults = getModelFamilySamplingDefaults();
    const thinkingStripper = createThinkingStripper();
    const result = await getTensorRtBackend().chat({
      system,
      prompt,
      maxTokens,
      temperature: payload.temperature ?? samplingDefaults.temperature,
      topP: payload.top_p ?? samplingDefaults.topP,
      topK: payload.top_k ?? samplingDefaults.topK,
      stop: payload.stop ?? [],
      stream,
      onToken: stream
        ? (text: string) => {
            if (abort.signal.aborted || res.writableEnded) return;
            recordToken();
            if (text.includes("<think>")) setState("thinking", "Thinking…");
            else if (text.includes("</think>"))
              setState("generating", "Generating…");
            else if (statsTracker.getInferenceState() === "prefilling")
              setState("generating", "Generating…");
            const stripped = thinkingStripper.push(text);
            applyThinkingState({
              enteredThinking: stripped.enteredThinking,
              exitedThinking: stripped.exitedThinking,
              generatingOperation: "Generating...",
            });
            if (stripped.visibleText) {
              res.write(
                sseChunk({
                  id: reqId,
                  object: "chat.completion.chunk",
                  created,
                  model: modelName,
                  choices: [
                    {
                      index: 0,
                      delta: { content: stripped.visibleText },
                      finish_reason: null,
                    },
                  ],
                }),
              );
            }
          }
        : undefined,
    });

    if (!stream) {
      const tokenCount =
        result.tokenCount > 0
          ? result.tokenCount
          : Math.ceil(result.text.length / 4);
      recordTokenCount(tokenCount);
    }
    stopStatsBroadcast();

    if (abort.signal.aborted) {
      if (stream && !res.writableEnded) {
        res.write(
          sseChunk({
            id: reqId,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return;
    }

    if (stream) {
      if (!res.writableEnded) {
        const pendingText = thinkingStripper.flush();
        if (pendingText) {
          res.write(
            sseChunk({
              id: reqId,
              object: "chat.completion.chunk",
              created,
              model: modelName,
              choices: [
                {
                  index: 0,
                  delta: { content: pendingText },
                  finish_reason: null,
                },
              ],
            }),
          );
        }
        res.write(
          sseChunk({
            id: reqId,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: result.promptTokens || estimatedInputTokens,
              completion_tokens: result.tokenCount,
              total_tokens:
                (result.promptTokens || estimatedInputTokens) +
                result.tokenCount,
            },
          }),
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } else {
      const tokenCount =
        result.tokenCount > 0
          ? result.tokenCount
          : Math.ceil(result.text.length / 4);
      const visibleText = stripThinkingBlocks(result.text).visibleText.trim();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: reqId,
          object: "chat.completion",
          created,
          model: modelName,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: visibleText },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: result.promptTokens || estimatedInputTokens,
            completion_tokens: tokenCount,
            total_tokens:
              (result.promptTokens || estimatedInputTokens) + tokenCount,
          },
        }),
      );
    }
  } catch (err) {
    stopStatsBroadcast();
    logger.error("[inference/tensorrt] error:", err);
    if (stream && !res.writableEnded) {
      res.write(sseChunk({ error: { message: String(err) } }));
      res.write("data: [DONE]\n\n");
      res.end();
    } else if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: "tensorrt_error",
          },
        }),
      );
    }
  } finally {
    setIsInferring(false);
    currentAbort = null;
    emitStatusChanged();
  }
}

async function handleTensorRtRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (currentBackend !== "tensorrt-native") {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "No model loaded. Load a model in the Engine screen first.",
          type: "model_not_loaded",
        },
      }),
    );
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: { message: "Failed to read request body" } }),
    );
    return;
  }

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
    return;
  }

  const rawMessages: OpenAIMessage[] = payload.messages ?? [];
  if (rawMessages.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "messages array is empty" } }));
    return;
  }

  const modelName = currentModelPath?.split(/[/\\]/).pop() ?? "embedded";
  const reqId = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  await handleTensorRtChatCompletions(
    rawMessages,
    payload,
    req,
    res,
    reqId,
    created,
    modelName,
  );
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ─── TensorRT HTTP server (only active when TensorRT is the loaded backend) ──

function ensureTensorRtServerListening(): Promise<void> {
  if (server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      try {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization",
        );
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = req.url ?? "";

        if (url === "/v1/models" && req.method === "GET") {
          const name = currentModelPath?.split(/[/\\]/).pop() ?? "no-model";
          const hasModel =
            currentBackend === "tensorrt-native" &&
            getTensorRtBackend().getStatus().loaded;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              object: "list",
              data: hasModel
                ? [
                    {
                      id: name,
                      object: "model",
                      created: 0,
                      owned_by: "orianbuilder",
                    },
                  ]
                : [],
            }),
          );
          return;
        }

        if (url === "/v1/chat/completions" && req.method === "POST") {
          await handleTensorRtRequest(req, res);
          return;
        }

        if (url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              modelLoaded: getServerStatus().modelLoaded,
              modelPath: currentModelPath,
              backend: currentBackend,
              gpuLayers: currentGpuLayers,
              contextSize: currentActualContextSize,
            }),
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      } catch (err) {
        logger.error("Unhandled HTTP error:", err);
        setIsInferring(false);
        currentAbort = null;
        emitStatusChanged();
        if (!res.headersSent)
          res.writeHead(500, { "Content-Type": "application/json" });
        if (!res.writableEnded)
          res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
    server.on("error", (err) => {
      server = null;
      reject(err);
    });
    server.listen(EMBEDDED_PORT, "127.0.0.1", () => {
      logger.info(`TensorRT HTTP server on port ${EMBEDDED_PORT}`);
      resolve();
    });
  });
}

function stopTensorRtServer(): Promise<void> {
  const current = server;
  if (!current) return Promise.resolve();
  server = null;
  return new Promise((resolve) => {
    current.close(() => {
      logger.info("TensorRT HTTP server stopped");
      resolve();
    });
  });
}

// ─── Public lifecycle hooks (called from main.ts at app start/exit) ──────────

export function startServer(): Promise<void> {
  // No port is bound at startup — whichever backend the user loads next
  // (llama-server child process or our TensorRT wrapper) will claim
  // EMBEDDED_PORT. Kept as a no-op so existing callers don't need to change.
  return Promise.resolve();
}

export async function stopServer(): Promise<void> {
  await _fullReset();
}
