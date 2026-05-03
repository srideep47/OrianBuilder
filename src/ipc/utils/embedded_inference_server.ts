import http from "node:http";
import log from "electron-log";
import {
  findDefaultTensorRtEngineDir,
  TensorRtNativeBackend,
} from "./tensorrt_native_backend";

const logger = log.scope("embedded-inference");

export const EMBEDDED_PORT = 11435;
export const EMBEDDED_BASE_URL = `http://127.0.0.1:${EMBEDDED_PORT}`;

// ─── State ───────────────────────────────────────────────────────────────────

let server: http.Server | null = null;
let llamaInstance: unknown = null;
let currentModel: unknown = null;
let currentContext: unknown = null;
let currentModelPath: string | null = null;
let currentGpuLayers = 0;
let currentTotalLayers = 0;
let currentActualContextSize = 0;
let currentBackend: "none" | "llama-cpp" | "tensorrt-native" = "none";
let tensorRtBackend: TensorRtNativeBackend | null = null;
let isLoading = false;
let isInferring = false;
let currentAbort: AbortController | null = null;

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
  isLoading: boolean;
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
}

export function getServerStatus(): EmbeddedServerStatus {
  const tensorRtStatus = getTensorRtBackend().getStatus();
  const tensorRtLoaded =
    currentBackend === "tensorrt-native" && tensorRtStatus.loaded;
  return {
    running: server !== null,
    modelLoaded: currentModel !== null || tensorRtLoaded,
    modelPath: currentModelPath,
    isLoading,
    backend: currentBackend,
    tensorRtRunnerAvailable: tensorRtStatus.runnerAvailable,
    tensorRtRuntimeAvailable: tensorRtStatus.runtimeAvailable,
    tensorRtRuntimePath: tensorRtStatus.runtimePath,
    tensorRtEngineDir: tensorRtStatus.engineDir,
    tensorRtEngineFormat: tensorRtStatus.engineFormat,
    gpuLayers: currentGpuLayers,
    totalLayers: currentTotalLayers,
    cpuLayers: Math.max(0, currentTotalLayers - currentGpuLayers),
    actualContextSize: currentActualContextSize,
  };
}

// ─── Live inference stats ─────────────────────────────────────────────────────

export type InferenceState =
  | "idle"
  | "loading"
  | "prefilling"
  | "generating"
  | "thinking"
  | "tool_calling";

export interface InferenceStats {
  state: InferenceState;
  operation: string;
  backend: "none" | "llama-cpp" | "tensorrt-native";
  liveTps: number;
  avgTps: number;
  prefillTps: number;
  promptTokens: number;
  prefillDurationMs: number;
  decodeTps: number;
  peakTps: number;
  lowestTps: number;
  tokensGenerated: number;
  sessionDurationMs: number;
  totalSessions: number;
  totalTokensAllTime: number;
}

export interface InferenceLogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
}

type StatsListener = (s: InferenceStats) => void;
type LogListener = (e: InferenceLogEntry) => void;

const statsListeners = new Set<StatsListener>();
const logListeners = new Set<LogListener>();
const logRingBuffer: InferenceLogEntry[] = [];
const LOG_RING_SIZE = 200;

// Sliding window for live TPS (1 s buckets, keep 3)
const TPS_WINDOW_SECONDS = 3;
interface TpsBucket {
  ts: number;
  count: number;
}
let tpsBuckets: TpsBucket[] = [];
let sessionStart = 0;
let prefillStart = 0;
let firstTokenAt = 0;
let currentPromptTokens = 0;
let currentPrefillDurationMs = 0;
let sessionTokens = 0;
let sessionPeakTps = 0;
let sessionLowestTps = Infinity;
let allTimeTotalTokens = 0;
let allTimeTotalSessions = 0;

let currentInferenceState: InferenceState = "idle";
let currentOperation = "";

export function addStatsListener(fn: StatsListener): () => void {
  statsListeners.add(fn);
  return () => statsListeners.delete(fn);
}

export function addLogListener(fn: LogListener): () => void {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

export function getRecentLogs(): InferenceLogEntry[] {
  return [...logRingBuffer];
}

export function getCurrentStats(): InferenceStats {
  const liveTps = computeLiveTps();
  const sessionDurationMs = sessionStart > 0 ? Date.now() - sessionStart : 0;
  const avgTps =
    sessionDurationMs > 0 ? (sessionTokens / sessionDurationMs) * 1000 : 0;
  const activePrefillMs =
    prefillStart > 0 &&
    firstTokenAt === 0 &&
    currentInferenceState === "prefilling"
      ? Date.now() - prefillStart
      : currentPrefillDurationMs;
  const prefillTps =
    currentPromptTokens > 0 && activePrefillMs > 0
      ? (currentPromptTokens / activePrefillMs) * 1000
      : 0;
  const decodeMs =
    firstTokenAt > 0
      ? Math.max(1, Date.now() - firstTokenAt)
      : sessionDurationMs;
  const decodeTps = sessionTokens > 0 ? (sessionTokens / decodeMs) * 1000 : 0;
  return {
    state: currentInferenceState,
    operation: currentOperation,
    backend: currentBackend,
    liveTps,
    avgTps,
    prefillTps,
    promptTokens: currentPromptTokens,
    prefillDurationMs: activePrefillMs,
    decodeTps,
    peakTps: sessionPeakTps,
    lowestTps: sessionLowestTps === Infinity ? 0 : sessionLowestTps,
    tokensGenerated: sessionTokens,
    sessionDurationMs,
    totalSessions: allTimeTotalSessions,
    totalTokensAllTime: allTimeTotalTokens,
  };
}

function computeLiveTps(): number {
  const cutoff = Date.now() - TPS_WINDOW_SECONDS * 1000;
  tpsBuckets = tpsBuckets.filter((b) => b.ts >= cutoff);
  const total = tpsBuckets.reduce((s, b) => s + b.count, 0);
  const windowMs =
    tpsBuckets.length > 0
      ? Math.max(1, Date.now() - tpsBuckets[0].ts)
      : TPS_WINDOW_SECONDS * 1000;
  return total > 0 ? (total / windowMs) * 1000 : 0;
}

function recordToken(): void {
  if (firstTokenAt === 0 && prefillStart > 0) {
    firstTokenAt = Date.now();
    currentPrefillDurationMs = Math.max(1, firstTokenAt - prefillStart);
  }
  sessionTokens++;
  allTimeTotalTokens++;
  const now = Date.now();
  if (
    tpsBuckets.length === 0 ||
    now - tpsBuckets[tpsBuckets.length - 1].ts > 500
  ) {
    tpsBuckets.push({ ts: now, count: 1 });
  } else {
    tpsBuckets[tpsBuckets.length - 1].count++;
  }
  const live = computeLiveTps();
  if (live > sessionPeakTps) sessionPeakTps = live;
  if (live > 0 && live < sessionLowestTps) sessionLowestTps = live;
}

function recordTokenCount(count: number): void {
  for (let i = 0; i < Math.max(0, count); i++) recordToken();
}

function setState(s: InferenceState, op = ""): void {
  currentInferenceState = s;
  currentOperation = op;
  broadcastStats();
}

function broadcastStats(): void {
  if (statsListeners.size === 0) return;
  const snap = getCurrentStats();
  for (const fn of statsListeners) fn(snap);
}

let statsBroadcastTimer: NodeJS.Timeout | null = null;
function startStatsBroadcast(): void {
  if (statsBroadcastTimer) return;
  statsBroadcastTimer = setInterval(broadcastStats, 250);
}
function stopStatsBroadcast(): void {
  if (statsBroadcastTimer) {
    clearInterval(statsBroadcastTimer);
    statsBroadcastTimer = null;
  }
  setState("idle", "");
  broadcastStats();
}

function beginSession(promptTokens: number): void {
  sessionStart = Date.now();
  prefillStart = sessionStart;
  firstTokenAt = 0;
  currentPromptTokens = promptTokens;
  currentPrefillDurationMs = 0;
  sessionTokens = 0;
  sessionPeakTps = 0;
  sessionLowestTps = Infinity;
  tpsBuckets = [];
  allTimeTotalSessions++;
  startStatsBroadcast();
}

// Emit log entries to the ring buffer + listeners
function emitLog(level: InferenceLogEntry["level"], msg: string): void {
  const entry: InferenceLogEntry = { ts: Date.now(), level, msg };
  logRingBuffer.push(entry);
  if (logRingBuffer.length > LOG_RING_SIZE) logRingBuffer.shift();
  for (const fn of logListeners) fn(entry);
}

// Hook electron-log for the inference scope
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
    emitLog(level as InferenceLogEntry["level"], text);
    return message;
  },
];

// ─── ESM import shim ─────────────────────────────────────────────────────────
const _esmImport = new Function("s", "return import(s)") as (
  s: string,
) => Promise<unknown>;
let llamaModule: typeof import("node-llama-cpp") | null = null;

async function getLlamaModule(): Promise<typeof import("node-llama-cpp")> {
  if (!llamaModule) {
    llamaModule = (await _esmImport(
      "node-llama-cpp",
    )) as typeof import("node-llama-cpp");
    logger.info("node-llama-cpp ESM module loaded");
  }
  return llamaModule;
}

// ─── Llama instance management ───────────────────────────────────────────────

async function getOrCreateLlamaInstance(): Promise<unknown> {
  if (llamaInstance) return llamaInstance;
  const { getLlama } = await getLlamaModule();
  llamaInstance = await getLlama({ gpu: "auto" });
  logger.info("Llama instance created");
  return llamaInstance;
}

async function destroyLlamaInstance(): Promise<void> {
  if (!llamaInstance) return;
  try {
    await (llamaInstance as any).dispose();
  } catch {
    /* ignore */
  }
  llamaInstance = null;
  llamaModule = null;
  logger.info("Llama instance destroyed");
}

function getTensorRtBackend(): TensorRtNativeBackend {
  tensorRtBackend ??= new TensorRtNativeBackend();
  return tensorRtBackend;
}

function getModelLoaded(): boolean {
  return (
    currentModel !== null ||
    (currentBackend === "tensorrt-native" &&
      getTensorRtBackend().getStatus().loaded)
  );
}

// ─── GPU layer calculation ────────────────────────────────────────────────────

function calculateGpuLayers(
  vramMb: number,
  utilization: number,
  vramHeadroomMb: number | undefined,
  layerSizeMb: number,
  totalLayers: number,
  contextSize: number,
  kvBytesPerTokenPerLayer: number,
  attentionSlidingWindow?: number | null,
  attentionSlidingWindowPattern?: number | null,
  flashAttention?: boolean,
): number {
  if (vramMb <= 0 || layerSizeMb <= 0) return 0;
  const explicitHeadroomMb =
    typeof vramHeadroomMb === "number"
      ? Math.max(256, Math.min(4096, vramHeadroomMb))
      : null;
  const utilBudget = vramMb * Math.min(0.98, Math.max(0.3, utilization));
  const budget = Math.max(
    0,
    explicitHeadroomMb == null ? utilBudget : vramMb - explicitHeadroomMb,
  );
  const effectiveContextSize = getEffectiveKvContextSize(
    contextSize,
    attentionSlidingWindow,
    attentionSlidingWindowPattern,
    flashAttention,
  );
  const kvPerLayerMb =
    (Math.max(512, effectiveContextSize) * kvBytesPerTokenPerLayer) /
    (1024 * 1024);
  const perLayerMb = layerSizeMb + kvPerLayerMb;
  return Math.min(totalLayers, Math.floor(budget / perLayerMb));
}

function clampGpuLayers(layers: number, totalLayers: number): number {
  return Math.max(0, Math.min(totalLayers, Math.floor(layers)));
}

function getEffectiveKvContextSize(
  contextSize: number,
  attentionSlidingWindow?: number | null,
  attentionSlidingWindowPattern?: number | null,
  flashAttention?: boolean,
): number {
  const slidingWindow = attentionSlidingWindow ?? 0;
  if (slidingWindow <= 0 || slidingWindow >= contextSize) {
    return contextSize;
  }
  const pattern = Math.max(1, attentionSlidingWindowPattern ?? 1);
  const nonSwaPercent =
    pattern <= 1 ? 1 : 1 / (pattern + (flashAttention ? -0.5 : -1));
  return Math.ceil(
    (1 - nonSwaPercent) * slidingWindow + nonSwaPercent * contextSize,
  );
}

const OOM_KEYWORDS = [
  "VRAM",
  "vram",
  "memory",
  "Memory",
  "OOM",
  "OutOfMemory",
  "out of memory",
  "context size",
  "Context size",
  "too large",
  "CUDA",
  "cuda",
  "cuLaunchKernel",
  "allocation failed",
];

function isOomError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return OOM_KEYWORDS.some((kw) => msg.includes(kw));
}

// ─── Model loading with progressive GPU-layer fallback ───────────────────────

export async function loadModel(config: EmbeddedModelConfig): Promise<void> {
  if (isLoading) throw new Error("A model is already loading");
  isLoading = true;

  if (config.inferenceBackend === "tensorrt-native") {
    await loadTensorRtModel(config);
    return;
  }

  setState("loading", `Loading ${config.modelPath.split(/[/\\]/).pop()}…`);

  const vramMb = config._vramMb ?? 0;
  const layerSizeMb = config._layerSizeMb ?? 200;
  const totalLayers = config._estimatedLayers ?? 64;
  const kvBytesPerTokenPerLayer = config._kvBytesPerTokenPerLayer ?? 4096;
  const flashAttention = config.flashAttention ?? true;
  const autoGpuLayers = calculateGpuLayers(
    vramMb,
    config.gpuMemoryUtilization,
    config.vramHeadroomMb,
    layerSizeMb,
    totalLayers,
    config.contextSize,
    kvBytesPerTokenPerLayer,
    config._attentionSlidingWindow,
    config._attentionSlidingWindowPattern,
    flashAttention,
  );
  const baseGpuLayers =
    config.gpuLayersMode === "manual" &&
    typeof config.manualGpuLayers === "number"
      ? clampGpuLayers(config.manualGpuLayers, totalLayers)
      : autoGpuLayers;
  const aggressiveMemory = config.aggressiveMemory ?? true;
  const batchSize = config.batchSize ?? 512;

  const attempts: Array<{
    gpuLayers: number;
    ctxMax: number;
    ctxMin: number;
    label: string;
  }> = [
    {
      gpuLayers: baseGpuLayers,
      ctxMax: config.contextSize,
      ctxMin: aggressiveMemory ? config.contextSize : 256,
      label: "initial",
    },
    {
      gpuLayers: Math.floor(baseGpuLayers * 0.75),
      ctxMax: config.contextSize,
      ctxMin: aggressiveMemory ? config.contextSize : 256,
      label: "75% layers",
    },
    {
      gpuLayers: Math.floor(baseGpuLayers * 0.5),
      ctxMax: config.contextSize,
      ctxMin: aggressiveMemory ? config.contextSize : 256,
      label: "50% layers",
    },
    {
      gpuLayers: Math.floor(baseGpuLayers * 0.25),
      ctxMax: config.contextSize,
      ctxMin: 128,
      label: "25% layers",
    },
    {
      gpuLayers: 0,
      ctxMax: config.contextSize,
      ctxMin: 64,
      label: "CPU-only",
    },
    {
      gpuLayers: 0,
      ctxMax: Math.min(config.contextSize, 32768),
      ctxMin: 64,
      label: "CPU-only reduced context",
    },
  ];

  logger.info(
    `Loading: ${config.modelPath} | util=${(config.gpuMemoryUtilization * 100).toFixed(0)}% | ` +
      `headroom=${config.vramHeadroomMb ?? "legacy"}MB | aggressive=${aggressiveMemory} | ` +
      `gpuLayers=${baseGpuLayers}/${totalLayers} (${config.gpuLayersMode ?? "auto"}) | ` +
      `ctx≤${config.contextSize} | kv=${(kvBytesPerTokenPerLayer / 1024).toFixed(1)}KB/token/layer | ` +
      `vram=${(vramMb / 1024).toFixed(1)}GB`,
  );

  await _fullReset();
  currentBackend = "llama-cpp";
  let lastError: unknown = new Error("No load attempt made");

  for (const attempt of attempts) {
    if (attempt.gpuLayers < 0) continue;
    if (
      attempt.gpuLayers === 0 &&
      attempt.label !== "CPU-only" &&
      baseGpuLayers === 0
    )
      continue;

    logger.info(
      `[${attempt.label}] gpuLayers=${attempt.gpuLayers}, ctx=${attempt.ctxMin}–${attempt.ctxMax}`,
    );

    try {
      const llama = await getOrCreateLlamaInstance();
      const model = await (llama as any).loadModel({
        modelPath: config.modelPath,
        gpuLayers:
          attempt.gpuLayers > 0 ? { min: 0, max: attempt.gpuLayers } : 0,
        defaultContextFlashAttention: flashAttention,
      });
      const actualGpu: number = (model as any).gpuLayers ?? attempt.gpuLayers;
      logger.info(
        `[${attempt.label}] Weights loaded — GPU ${actualGpu} / CPU ${totalLayers - actualGpu}`,
      );

      const ctx = await (model as any).createContext({
        contextSize:
          aggressiveMemory && attempt.ctxMin === attempt.ctxMax
            ? attempt.ctxMax
            : { min: attempt.ctxMin, max: attempt.ctxMax },
        flashAttention,
        batchSize: Math.min(batchSize, attempt.ctxMax),
        ignoreMemorySafetyChecks: aggressiveMemory,
        failedCreationRemedy: aggressiveMemory ? false : undefined,
      });
      const actualCtx: number = (ctx as any).contextSize ?? attempt.ctxMax;
      const allocatedCtx: number =
        typeof (ctx as any).getAllocatedContextSize === "function"
          ? (ctx as any).getAllocatedContextSize()
          : actualCtx;
      logger.info(
        `[${attempt.label}] Context created — ${actualCtx} tokens (${allocatedCtx} allocated)`,
      );

      currentModel = model;
      currentContext = ctx;
      currentModelPath = config.modelPath;
      currentBackend = "llama-cpp";
      currentGpuLayers = actualGpu;
      currentTotalLayers = totalLayers;
      currentActualContextSize = actualCtx;
      isLoading = false;
      setState("idle", "Model ready");
      return;
    } catch (err) {
      lastError = err;
      logger.warn(
        `[${attempt.label}] Failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        await (currentContext as any)?.dispose();
      } catch {
        /* ignore */
      }
      try {
        await (currentModel as any)?.dispose();
      } catch {
        /* ignore */
      }
      currentContext = null;
      currentModel = null;
      await destroyLlamaInstance();

      if (!isOomError(err)) {
        currentModelPath = null;
        currentBackend = "none";
        currentGpuLayers = 0;
        currentActualContextSize = 0;
        isLoading = false;
        throw err;
      }
    }
  }

  currentModelPath = null;
  currentBackend = "none";
  currentGpuLayers = 0;
  currentTotalLayers = 0;
  currentActualContextSize = 0;
  isLoading = false;
  const msg =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Model failed to load on all ${attempts.length} attempts (including CPU-only).\n\n` +
      `Last error: ${msg}\n\n` +
      `Try: (1) Close GPU-heavy apps. (2) Lower "GPU Memory Utilization". (3) Use a smaller quantized model.`,
  );
}

async function loadTensorRtModel(config: EmbeddedModelConfig): Promise<void> {
  const engineDir = config.tensorRtEngineDir ?? findDefaultTensorRtEngineDir();
  if (!engineDir) {
    isLoading = false;
    currentBackend = "none";
    throw new Error(
      "TensorRT engine directory not found. Select a compiled engine directory containing engine_meta.json.",
    );
  }

  setState("loading", `Loading TensorRT engine ${engineDir}...`);
  await _fullReset();
  currentBackend = "tensorrt-native";
  try {
    await getTensorRtBackend().load(engineDir);
    currentModelPath = engineDir;
    currentGpuLayers = config._estimatedLayers ?? 0;
    currentTotalLayers = config._estimatedLayers ?? 0;
    currentActualContextSize = config.contextSize;
    isLoading = false;
    setState("idle", "TensorRT engine ready");
  } catch (err) {
    currentBackend = "none";
    currentModelPath = null;
    currentGpuLayers = 0;
    currentTotalLayers = 0;
    currentActualContextSize = 0;
    isLoading = false;
    throw err;
  }
}

async function _fullReset(): Promise<void> {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }
  isInferring = false;
  if (currentContext) {
    try {
      await (currentContext as any).dispose();
    } catch {
      /* ignore */
    }
    currentContext = null;
  }
  if (currentModel) {
    try {
      await (currentModel as any).dispose();
    } catch {
      /* ignore */
    }
    currentModel = null;
  }
  currentModelPath = null;
  currentBackend = "none";
  currentGpuLayers = 0;
  currentTotalLayers = 0;
  currentActualContextSize = 0;
  await destroyLlamaInstance();
  await tensorRtBackend?.unload();
}

export async function unloadModel(): Promise<void> {
  await _fullReset();
  logger.info("Model unloaded");
}

// Abort any in-progress inference and clear the busy flag.
// Safe to call even when nothing is running.
export function abortCurrentInference(): void {
  if (currentAbort && !currentAbort.signal.aborted) {
    currentAbort.abort();
  }
  currentAbort = null;
  isInferring = false;
  logger.info("Inference aborted by caller");
}

// ─── OpenAI → node-llama-cpp message conversion ──────────────────────────────
//
// The agent passes a full conversation that includes:
//   • system message (huge Dyad system prompt with codebase)
//   • user messages
//   • assistant messages (may include tool_calls)
//   • tool messages (results of previous tool calls)
//
// We convert the entire array to LlamaChatHistory so the model gets full context
// and the chat template (ChatML, Llama3, etc.) is applied correctly.

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: string;
  content?: unknown;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface NlcSystemMessage {
  type: "system";
  text: string;
}
interface NlcUserMessage {
  type: "user";
  text: string;
}
interface NlcModelMessage {
  type: "model";
  response: Array<
    | string
    | { type: "functionCall"; name: string; params: unknown; result: unknown }
  >;
}
type NlcHistoryItem = NlcSystemMessage | NlcUserMessage | NlcModelMessage;

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function stringifyOpenAIContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") {
    return String(content);
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part == null) return "";
        if (typeof part === "string") return part;
        if (typeof part === "number" || typeof part === "boolean") {
          return String(part);
        }
        if (typeof part === "object") {
          const typedPart = part as Record<string, unknown>;
          if (typeof typedPart.text === "string") return typedPart.text;
          if (typeof typedPart.value === "string") return typedPart.value;
          if (typedPart.type === "image" || typedPart.type === "image_url") {
            return "[image]";
          }
          return safeJsonStringify(typedPart);
        }
        return String(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") return safeJsonStringify(content);
  return String(content);
}

function estimateOpenAIRequestTokens(
  rawMessages: OpenAIMessage[],
  payload?: { tools?: unknown },
): number {
  const messageChars = rawMessages.reduce((sum, message) => {
    let chars =
      stringifyOpenAIContent(message.content).length + message.role.length + 8;
    if (message.tool_calls)
      chars += safeJsonStringify(message.tool_calls).length;
    if (message.tool_call_id) chars += message.tool_call_id.length;
    return sum + chars;
  }, 0);
  const toolChars = payload?.tools
    ? safeJsonStringify(payload.tools).length
    : 0;
  return Math.ceil((messageChars + toolChars) / 4);
}

function openAiToLlamaChatInput(rawMessages: OpenAIMessage[]): {
  history: NlcHistoryItem[];
  userPrompt: string;
} {
  const history: NlcHistoryItem[] = [];

  // Collect system messages first (Dyad puts the codebase here)
  const systemParts = rawMessages
    .filter((m) => m.role === "system")
    .map((m) => stringifyOpenAIContent(m.content));
  if (systemParts.length > 0) {
    history.push({ type: "system", text: systemParts.join("\n\n") });
  }

  const conv = rawMessages.filter((m) => m.role !== "system");

  // Walk through conversation, grouping assistant+tool pairs
  let i = 0;
  while (i < conv.length) {
    const msg = conv[i];

    if (msg.role === "user") {
      const content = stringifyOpenAIContent(msg.content);
      // The LAST user message becomes the prompt arg to session.prompt()
      if (i === conv.length - 1) {
        return { history, userPrompt: content };
      }
      history.push({ type: "user", text: content });
      i++;
      continue;
    }

    if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Build a model turn containing all function calls with their results
        const response: NlcModelMessage["response"] = [];

        for (const tc of msg.tool_calls) {
          let params: unknown;
          try {
            params = JSON.parse(tc.function.arguments || "{}");
          } catch {
            params = {};
          }

          // Find the matching tool result that follows
          const resultMsg = conv.find(
            (m, idx) =>
              idx > i && m.role === "tool" && m.tool_call_id === tc.id,
          );
          response.push({
            type: "functionCall" as const,
            name: tc.function.name,
            params,
            result: stringifyOpenAIContent(resultMsg?.content),
          });
        }

        // If the assistant also emitted text alongside the tool calls, prepend it
        const content = stringifyOpenAIContent(msg.content);
        if (content) response.unshift(content);
        history.push({ type: "model", response });

        // Skip past all the tool result messages that were consumed above
        i++;
        while (i < conv.length && conv[i].role === "tool") i++;
        continue;
      }

      // Plain text assistant turn
      const content = stringifyOpenAIContent(msg.content);
      if (content) {
        history.push({ type: "model", response: [content] });
      }
      i++;
      continue;
    }

    if (msg.role === "tool") {
      // Orphaned tool message (already consumed above) — skip
      i++;
      continue;
    }

    i++;
  }

  // If we reach here, the last message was NOT a user message (likely tool results).
  // Inject a synthetic continuation trigger so the model generates the next action.
  return { history, userPrompt: "[System] Continue with the next step." };
}

function openAiToPlainPrompt(rawMessages: OpenAIMessage[]): {
  system: string;
  prompt: string;
} {
  const system = rawMessages
    .filter((m) => m.role === "system")
    .map((m) => stringifyOpenAIContent(m.content))
    .join("\n\n");
  const turns = rawMessages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const content = stringifyOpenAIContent(m.content);
      if (m.role === "assistant") return `Assistant: ${content}`;
      if (m.role === "tool") return `Tool: ${content}`;
      return `User: ${content}`;
    });
  return {
    system,
    prompt: `${turns.join("\n\n")}\n\nAssistant:`,
  };
}

// ─── Sampling options helper ──────────────────────────────────────────────────

function buildSamplingOpts(
  payload: any,
  maxTokens: number,
): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    maxTokens,
    temperature: payload.temperature ?? defaultSampling.temperature,
    topP: payload.top_p ?? defaultSampling.topP,
    topK: payload.top_k ?? defaultSampling.topK,
    repeatPenalty: {
      penalty:
        payload.repeat_penalty ??
        payload.frequency_penalty ??
        defaultSampling.repeatPenalty,
      penalizeNewLine: false,
    },
  };
  const seed = payload.seed ?? defaultSampling.seed;
  if (typeof seed === "number") opts.seed = seed;
  return opts;
}

// ─── Tool call streaming helpers ─────────────────────────────────────────────

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// ─── Inference: WITH tools (agent / app-building mode) ───────────────────────
//
// Uses node-llama-cpp's native function-calling (promptWithMeta + functions).
// Strategy:
//   1. Register every OpenAI tool as a node-llama-cpp function.
//   2. Each function handler records the call then ABORTS the generation signal.
//   3. Because we use AbortSignal.any(outerSignal, innerAbort), aborting in the
//      handler stops generation right after the function call — we get the
//      pre-call text + the call itself, but NOT any text generated after the
//      fake "" result is fed back.
//   4. Stream: pre-call text as text deltas, then tool-call deltas, then finish.
//
// On the AI SDK side, the agent then executes the tool and sends the NEXT request
// with the tool result already in the messages array. Our openAiToLlamaChatInput
// converts those tool results into ChatModelFunctionCall history items so the
// model gets full context for the continuation.

async function handleWithTools(
  session: any,
  userPrompt: string,
  payload: any,
  outerAbort: AbortController,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqId: string,
  created: number,
  modelName: string,
): Promise<void> {
  const stream: boolean = payload.stream ?? false;
  const maxTokens: number = payload.max_tokens ?? 8192;
  const samplingOpts = buildSamplingOpts(payload, maxTokens);

  // ── Build node-llama-cpp functions from OpenAI tools ──────────────────────
  const tools: Array<{
    type: "function";
    function: { name: string; description?: string; parameters?: unknown };
  }> = payload.tools ?? [];

  const recordedCalls: Array<{ id: string; name: string; arguments: string }> =
    [];
  // Abort when the first function handler fires — stops generation after the call.
  const innerAbort = new AbortController();
  const combinedSignal = AbortSignal.any([
    outerAbort.signal,
    innerAbort.signal,
  ]);

  const nlcFunctions: Record<string, unknown> = {};
  for (const tool of tools) {
    const name = tool.function.name;
    nlcFunctions[name] = {
      description: tool.function.description ?? "",
      params: tool.function.parameters ?? { type: "object", properties: {} },
      handler: (params: unknown) => {
        const id = `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        let argumentsStr = "";
        try {
          argumentsStr = JSON.stringify(params ?? {});
        } catch {
          argumentsStr = "{}";
        }
        recordedCalls.push({ id, name, arguments: argumentsStr });
        setState("tool_calling", `Calling ${name}…`);
        if (!innerAbort.signal.aborted) innerAbort.abort();
        return "";
      },
    };
  }

  // ── Buffer text generated BEFORE the first tool call ─────────────────────
  let preToolText = "";
  let toolCallFired = false;

  logger.info(
    `[inference/tools] turns=${payload.messages?.length ?? 0} ` +
      `userPromptLen=${userPrompt.length} tools=${tools.length} stream=${stream} maxTokens=${maxTokens}`,
  );

  beginSession(
    payload._dyadEstimatedInputTokens ?? Math.ceil(userPrompt.length / 4),
  );
  setState("prefilling", "Processing context…");

  // ── Run generation ────────────────────────────────────────────────────────
  let promptResult: any;
  try {
    promptResult = await session.promptWithMeta(userPrompt, {
      ...samplingOpts,
      functions: nlcFunctions,
      signal: combinedSignal,
      stopOnAbortSignal: true,
      onTextChunk: (text: string) => {
        recordToken();
        // Detect <think>...</think> blocks for thinking state
        if (text.includes("<think>")) {
          setState("thinking", "Thinking…");
        } else if (text.includes("</think>")) {
          setState("generating", "Generating…");
        } else if (currentInferenceState === "prefilling") {
          setState("generating", "Generating…");
        }
        if (!toolCallFired) {
          preToolText += text;
        }
      },
    } as any);
  } catch (err: any) {
    // Abort from inner signal or HTTP disconnect is expected
    if (!outerAbort.signal.aborted) {
      logger.error("[inference/tools] promptWithMeta error:", err);
    }
    promptResult = null;
  }

  stopStatsBroadcast();
  // After the handler fires (and sets toolCallFired), `recordedCalls` is populated.
  toolCallFired = recordedCalls.length > 0;

  // Also extract any tool calls visible in the response array
  if (promptResult?.response) {
    for (const item of promptResult.response as unknown[]) {
      if (
        item &&
        typeof item === "object" &&
        (item as any).type === "functionCall"
      ) {
        const fc = item as any;
        const alreadyRecorded = recordedCalls.some((c) => c.name === fc.name);
        if (!alreadyRecorded) {
          let argumentsStr = "";
          try {
            argumentsStr = JSON.stringify(fc.params ?? {});
          } catch {
            argumentsStr = "{}";
          }
          recordedCalls.push({
            id: `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            name: fc.name,
            arguments: argumentsStr,
          });
        }
      }
    }
  }

  if (outerAbort.signal.aborted) {
    if (!res.writableEnded) {
      if (stream && !res.headersSent) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
      }
      if (stream)
        res.write(
          sseChunk({
            id: reqId,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        );
      if (stream) res.write("data: [DONE]\n\n");
      res.end();
    }
    return;
  }

  // ── Emit response ─────────────────────────────────────────────────────────
  const hasToolCalls = recordedCalls.length > 0;
  const finishReason = hasToolCalls ? "tool_calls" : "stop";

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Initial role delta
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

    // Pre-tool text
    if (preToolText) {
      res.write(
        sseChunk({
          id: reqId,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [
            { index: 0, delta: { content: preToolText }, finish_reason: null },
          ],
        }),
      );
    }

    // Tool call deltas — send each tool call as its own chunk
    if (hasToolCalls) {
      for (let idx = 0; idx < recordedCalls.length; idx++) {
        const tc = recordedCalls[idx];
        // Start chunk: includes id, name, type
        res.write(
          sseChunk({
            id: reqId,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: idx,
                      id: tc.id,
                      type: "function",
                      function: { name: tc.name, arguments: "" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        );
        // Arguments chunk
        res.write(
          sseChunk({
            id: reqId,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: idx,
                      function: { arguments: tc.arguments },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        );
      }
    }

    // Finish
    res.write(
      sseChunk({
        id: reqId,
        object: "chat.completion.chunk",
        created,
        model: modelName,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage: {
          completion_tokens:
            recordedCalls.length + Math.ceil(preToolText.length / 4),
          prompt_tokens: 0,
          total_tokens: 0,
        },
      }),
    );
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    // Non-streaming
    const message: any = {
      role: "assistant",
      content: preToolText || null,
    };
    if (hasToolCalls) {
      message.tool_calls = recordedCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: reqId,
        object: "chat.completion",
        created,
        model: modelName,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    );
  }
}

// ─── Inference: WITHOUT tools (plain chat mode) ───────────────────────────────

async function handleWithoutTools(
  session: any,
  userPrompt: string,
  payload: any,
  outerAbort: AbortController,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  reqId: string,
  created: number,
  modelName: string,
): Promise<void> {
  const stream: boolean = payload.stream ?? false;
  const maxTokens: number = payload.max_tokens ?? 8192;
  const samplingOpts = buildSamplingOpts(payload, maxTokens);

  logger.info(
    `[inference/chat] turns=${payload.messages?.length ?? 0} ` +
      `userPromptLen=${userPrompt.length} stream=${stream} maxTokens=${maxTokens}`,
  );

  req.on("close", () => {
    if (!res.writableEnded && !outerAbort.signal.aborted) outerAbort.abort();
  });

  beginSession(
    payload._dyadEstimatedInputTokens ?? Math.ceil(userPrompt.length / 4),
  );
  setState("prefilling", "Processing context…");

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

    let tokenCount = 0;
    let aborted = false;
    try {
      await session.prompt(userPrompt, {
        ...samplingOpts,
        signal: outerAbort.signal,
        stopOnAbortSignal: true,
        onTextChunk: (text: string) => {
          if (outerAbort.signal.aborted) return;
          recordToken();
          tokenCount++;
          if (text.includes("<think>")) {
            setState("thinking", "Thinking…");
          } else if (text.includes("</think>")) {
            setState("generating", "Generating response…");
          } else if (currentInferenceState === "prefilling") {
            setState("generating", "Generating response…");
          }
          res.write(
            sseChunk({
              id: reqId,
              object: "chat.completion.chunk",
              created,
              model: modelName,
              choices: [
                { index: 0, delta: { content: text }, finish_reason: null },
              ],
            }),
          );
        },
      } as any);
    } catch (err: any) {
      if (outerAbort.signal.aborted) {
        aborted = true;
      } else {
        logger.error("[inference/chat] streaming error:", err);
        if (!res.writableEnded)
          res.write(sseChunk({ error: { message: String(err) } }));
      }
    } finally {
      stopStatsBroadcast();
      if (!res.writableEnded) {
        if (!aborted) {
          res.write(
            sseChunk({
              id: reqId,
              object: "chat.completion.chunk",
              created,
              model: modelName,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                completion_tokens: tokenCount,
                prompt_tokens: 0,
                total_tokens: tokenCount,
              },
            }),
          );
          res.write("data: [DONE]\n\n");
        }
        res.end();
      }
    }
  } else {
    try {
      const output: string = await session.prompt(userPrompt, {
        ...samplingOpts,
        signal: outerAbort.signal,
        stopOnAbortSignal: true,
        onTextChunk: (text: string) => {
          recordToken();
          if (text.includes("<think>")) {
            setState("thinking", "Thinking…");
          } else if (text.includes("</think>")) {
            setState("generating", "Generating response…");
          } else if (currentInferenceState === "prefilling") {
            setState("generating", "Generating response…");
          }
        },
      } as any);
      stopStatsBroadcast();
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
              message: { role: "assistant", content: output },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
      );
    } catch (err) {
      stopStatsBroadcast();
      if (!res.headersSent)
        res.writeHead(500, { "Content-Type": "application/json" });
      if (!res.writableEnded)
        res.end(JSON.stringify({ error: { message: String(err) } }));
      logger.error("[inference/chat] non-streaming error:", err);
    }
  }
}

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

  // Guard: one request at a time (same as llama.cpp path)
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

  isInferring = true;
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
    // Initial role delta
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
    const result = await getTensorRtBackend().chat({
      system,
      prompt,
      maxTokens,
      temperature: payload.temperature ?? defaultSampling.temperature,
      topP: payload.top_p ?? defaultSampling.topP,
      topK: payload.top_k ?? defaultSampling.topK,
      stop: payload.stop ?? [],
      stream,
      onToken: stream
        ? (text: string) => {
            if (abort.signal.aborted || res.writableEnded) return;
            recordToken();
            if (text.includes("<think>")) setState("thinking", "Thinking…");
            else if (text.includes("</think>"))
              setState("generating", "Generating…");
            else if (currentInferenceState === "prefilling")
              setState("generating", "Generating…");
            res.write(
              sseChunk({
                id: reqId,
                object: "chat.completion.chunk",
                created,
                model: modelName,
                choices: [
                  { index: 0, delta: { content: text }, finish_reason: null },
                ],
              }),
            );
          }
        : undefined,
    });

    if (!stream) {
      // Non-streaming: record tokens in bulk
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
              message: { role: "assistant", content: result.text },
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
    isInferring = false;
    currentAbort = null;
  }
}

// ─── HTTP /v1/chat/completions handler ───────────────────────────────────────

async function handleChatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!getModelLoaded()) {
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

  const { history, userPrompt } = openAiToLlamaChatInput(rawMessages);

  // ── Context overflow pre-check ────────────────────────────────────────────
  // Estimate prompt token count. If it clearly exceeds the loaded context,
  // return an actionable error rather than silently truncating.
  const estimatedInputTokens = estimateOpenAIRequestTokens(
    rawMessages,
    payload,
  );
  payload._dyadEstimatedInputTokens = estimatedInputTokens;
  const safeLimit = Math.floor(currentActualContextSize * 0.8);
  if (estimatedInputTokens > safeLimit) {
    const msg =
      `Prompt is ~${estimatedInputTokens} tokens but the loaded model only has ` +
      `${currentActualContextSize} tokens of context (80% safe limit = ${safeLimit} tokens). ` +
      `Open the Engine screen and reload the model with a larger Context Size ` +
      `(recommended ≥ ${Math.ceil(estimatedInputTokens / 1024) * 1024 * 2} tokens for this app).`;
    logger.warn(
      `[inference] Context overflow: ~${estimatedInputTokens} estimated tokens > ${safeLimit} safe limit`,
    );
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: { message: msg, type: "context_overflow" } }),
    );
    return;
  }

  const modelName = currentModelPath?.split(/[/\\]/).pop() ?? "embedded";
  const reqId = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  if (currentBackend === "tensorrt-native") {
    await handleTensorRtChatCompletions(
      rawMessages,
      payload,
      req,
      res,
      reqId,
      created,
      modelName,
    );
    return;
  }

  const { LlamaChatSession } = await getLlamaModule();

  isInferring = true;
  const abort = new AbortController();
  currentAbort = abort;
  req.on("close", () => {
    if (!abort.signal.aborted) abort.abort();
  });

  let sequence: unknown = null;
  try {
    sequence = (currentContext as any).getSequence();
  } catch (err) {
    isInferring = false;
    currentAbort = null;
    logger.error("Failed to acquire context sequence:", err);
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `Could not acquire inference context: ${String(err)}`,
        },
      }),
    );
    return;
  }

  const disposeSeq = () => {
    try {
      (sequence as any).dispose();
    } catch {
      /* ignore */
    }
    isInferring = false;
    currentAbort = null;
  };

  let session: any;
  try {
    session = new LlamaChatSession({
      contextSequence: sequence as any,
      // Keep system prompt when context fills — critical for Dyad since the
      // system prompt carries the full app codebase and instructions.
      contextShift: { strategy: "eraseFirstResponseAndKeepFirstSystem" },
      autoDisposeSequence: false,
    });
    // Load full conversation history including any previous tool calls + results.
    if (history.length > 0) {
      session.setChatHistory(history);
    }
  } catch (err) {
    disposeSeq();
    logger.error("Failed to create chat session:", err);
    if (!res.headersSent)
      res.writeHead(500, { "Content-Type": "application/json" });
    if (!res.writableEnded)
      res.end(
        JSON.stringify({
          error: { message: `Session creation failed: ${String(err)}` },
        }),
      );
    return;
  }

  try {
    const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0;

    if (hasTools) {
      await handleWithTools(
        session,
        userPrompt,
        payload,
        abort,
        req,
        res,
        reqId,
        created,
        modelName,
      );
    } else {
      await handleWithoutTools(
        session,
        userPrompt,
        payload,
        abort,
        req,
        res,
        reqId,
        created,
        modelName,
      );
    }
  } finally {
    disposeSeq();
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

export function startServer(): Promise<void> {
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
            currentModel !== null ||
            (currentBackend === "tensorrt-native" &&
              getTensorRtBackend().getStatus().loaded);
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
          await handleChatCompletions(req, res);
          return;
        }

        if (url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              modelLoaded: getModelLoaded(),
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
        isInferring = false;
        currentAbort = null;
        if (!res.headersSent)
          res.writeHead(500, { "Content-Type": "application/json" });
        if (!res.writableEnded)
          res.end(JSON.stringify({ error: { message: String(err) } }));
      }
    });
    server.on("error", reject);
    server.listen(EMBEDDED_PORT, "127.0.0.1", () => {
      logger.info(`Inference server on port ${EMBEDDED_PORT}`);
      resolve();
    });
  });
}

export async function stopServer(): Promise<void> {
  await _fullReset();
  if (!server) return;
  return new Promise((resolve) => {
    server!.close(() => {
      server = null;
      logger.info("Inference server stopped");
      resolve();
    });
  });
}
