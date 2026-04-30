import { ipcMain, dialog, BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import log from "electron-log";
import {
  loadModel,
  unloadModel,
  getServerStatus,
  setDefaultSampling,
  addStatsListener,
  addLogListener,
  getRecentLogs,
} from "../utils/embedded_inference_server";
import { detectGpu } from "../utils/gpu_detection";
import { readSettings, writeSettings } from "../../main/settings";
import { readGgufMetadata } from "../utils/gguf_metadata";
import { embeddedModelEvents } from "../types/embedded_model";

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

const execFileAsync = promisify(execFile);
const logger = log.scope("embedded-model-handler");

// ─── GPU stats ───────────────────────────────────────────────────────────────

async function getGpuStats() {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks.current.graphics",
      "--format=csv,noheader,nounits",
    ]);
    const parts = stdout
      .trim()
      .split(", ")
      .map((s) => s.trim());
    return {
      utilizationPercent: parseFloat(parts[0]) || 0,
      vramUsedMb: parseFloat(parts[1]) || 0,
      vramTotalMb: parseFloat(parts[2]) || 0,
      temperatureC: parseFloat(parts[3]) || 0,
      powerW: parseFloat(parts[4]) || 0,
      clockMhz: parseFloat(parts[5]) || 0,
    };
  } catch {
    return null;
  }
}

// ─── Model introspection ─────────────────────────────────────────────────────

/** Map known parameter counts to transformer layer counts */
function estimateLayers(paramBillions: number): number {
  if (paramBillions <= 0.5) return 24;
  if (paramBillions <= 1) return 24;
  if (paramBillions <= 1.8) return 28;
  if (paramBillions <= 3) return 36;
  if (paramBillions <= 4) return 32;
  if (paramBillions <= 7) return 32;
  if (paramBillions <= 8) return 32;
  if (paramBillions <= 14) return 40;
  if (paramBillions <= 20) return 48;
  if (paramBillions <= 27) return 64;
  if (paramBillions <= 32) return 64;
  if (paramBillions <= 35) return 64;
  if (paramBillions <= 72) return 80;
  return 96;
}

/** Parse quantization tag from filename */
function parseQuantization(filename: string): string {
  const q = filename.match(/[_-](Q\d[_A-Z0-9]*|IQ\d[_A-Z0-9]*|BF16|F16|F32)/i);
  return q ? q[1].toUpperCase() : "unknown";
}

/** Parse parameter count (billions) from GGUF filename */
function parseParamBillions(filename: string): number | null {
  // Matches patterns like: 27B, 27b, 7.5B, 0.5B, 1.5B, 70B
  const m = filename.match(/[_\-. (](\d+\.?\d*)\s*[bB](?:[_\-. )]|$)/);
  if (m) return parseFloat(m[1]);
  // Try at start of filename too
  const m2 = filename.match(/^(\d+\.?\d*)[bB]/i);
  if (m2) return parseFloat(m2[1]);
  return null;
}

// Quantization-specific VRAM loading factor.
// Loaded VRAM for model weights is smaller than the file size because GGUF
// packs metadata/headers, and quantized formats load compactly.
// Empirically measured values:
//   Q4_K_M: loaded ≈ 82% of file size  (17.48 GB → ~14.3 GB for all 64 layers)
//   Q5_K_M: loaded ≈ 88%
//   Q8_0:   loaded ≈ 95%
//   F16:    loaded ≈ 100%
function loadedVramFactor(quant: string): number {
  const q = quant.toUpperCase();
  if (q.startsWith("IQ") || q.includes("Q2") || q.includes("Q3")) return 0.72;
  if (q.includes("Q4")) return 0.82;
  if (q.includes("Q5")) return 0.88;
  if (q.includes("Q6") || q.includes("Q8")) return 0.94;
  if (q === "F16" || q === "BF16") return 1.0;
  return 0.85; // safe default
}

async function computeModelInfo(filePath: string, vramMb: number) {
  const fileName = filePath.split(/[/\\]/).pop() ?? "";
  const stat = fs.statSync(filePath);
  const fileSizeMb = Math.round(stat.size / (1024 * 1024));

  // Try to read real GGUF metadata first — much more accurate than filename guessing.
  let realLayers: number | null = null;
  let realQuant: string | null = null;
  let realCtxLength: number | null = null;
  let realKvHeads: number | null = null;
  let realEmbedding: number | null = null;
  let realHeadCount: number | null = null;
  let architecture: string | null = null;
  try {
    const md = await readGgufMetadata(filePath);
    realLayers = md.blockCount;
    realQuant = md.quantization;
    realCtxLength = md.contextLength;
    realKvHeads = md.attentionHeadCountKv ?? md.attentionHeadCount;
    realEmbedding = md.embeddingLength;
    realHeadCount = md.attentionHeadCount;
    architecture = md.architecture;
  } catch (err) {
    logger.warn(
      `GGUF metadata read failed for ${fileName}; falling back to filename heuristics:`,
      err,
    );
  }

  const paramBillions = parseParamBillions(fileName);
  const estimatedLayers =
    realLayers ?? (paramBillions ? estimateLayers(paramBillions) : 32);
  const quantization = realQuant ?? parseQuantization(fileName);

  // Actual per-layer VRAM when loaded (not file size / layers)
  const factor = loadedVramFactor(quantization);
  const loadedModelVramMb = fileSizeMb * factor;
  const layerSizeMb = Math.ceil(loadedModelVramMb / estimatedLayers);

  // Reserve VRAM for: CUDA runtime (512 MB) + KV cache headroom (2.5 GB).
  // This matches the 2048 MB floor the inference server applies when calculating
  // gpuLayers, so the UI preview stays in sync with what actually loads.
  const reservedMb = 3072;
  const usableVramMb = Math.max(0, vramMb - reservedMb);

  const maxSafeGpuLayers = Math.min(
    estimatedLayers,
    layerSizeMb > 0 ? Math.floor(usableVramMb / layerSizeMb) : 0,
  );

  // Recommended: 90% of safe max to leave headroom for CUDA overhead
  const recommendedGpuLayers = Math.max(0, Math.floor(maxSafeGpuLayers * 0.9));

  // Real KV bytes-per-token-per-layer:
  //   2 (K + V) × kvHeads × headDim × bytes_per_element (fp16 = 2)
  //   headDim = embedding / heads
  let kvBytesPerTokenPerLayer = 4096; // fallback (8 KV heads, headDim=128, fp16)
  if (realKvHeads && realEmbedding && realHeadCount) {
    const headDim = realEmbedding / realHeadCount;
    kvBytesPerTokenPerLayer = 2 * realKvHeads * headDim * 2;
  }

  const vramAfterModelMb = Math.max(
    0,
    usableVramMb - recommendedGpuLayers * layerSizeMb,
  );
  const maxCtxFromVram =
    recommendedGpuLayers > 0 && vramAfterModelMb > 0
      ? Math.floor(
          (vramAfterModelMb * 1024 * 1024) /
            (kvBytesPerTokenPerLayer * recommendedGpuLayers),
        )
      : 512;
  // Dyad's system prompt (app codebase + instructions) is typically 30K–60K tokens.
  // Recommend at least 32K so app building works correctly. Accept fewer GPU layers
  // as the trade-off — slower but correct beats fast with a 98-token response.
  const DYAD_MIN_CTX = 32768;
  const ctxCap = realCtxLength ?? 131072;
  const rawCtx = nearestPower2(maxCtxFromVram);

  let recommendedContextSize: number;
  if (rawCtx >= DYAD_MIN_CTX) {
    recommendedContextSize = Math.min(ctxCap, rawCtx);
  } else {
    // Try nudging up: check if 32K fits with the current GPU layer count.
    const kvFor32K =
      (DYAD_MIN_CTX * kvBytesPerTokenPerLayer * recommendedGpuLayers) /
      (1024 * 1024);
    if (kvFor32K <= vramAfterModelMb) {
      recommendedContextSize = Math.min(ctxCap, DYAD_MIN_CTX);
    } else if (
      (16384 * kvBytesPerTokenPerLayer * recommendedGpuLayers) /
        (1024 * 1024) <=
      vramAfterModelMb
    ) {
      recommendedContextSize = Math.min(ctxCap, 16384);
    } else {
      recommendedContextSize = Math.min(ctxCap, Math.max(512, rawCtx));
    }
  }

  return {
    filePath,
    fileName,
    fileSizeMb,
    paramBillions,
    quantization,
    estimatedLayers,
    layerSizeMb,
    recommendedGpuLayers,
    recommendedContextSize,
    maxSafeGpuLayers,
    architecture,
    contextLengthTrained: realCtxLength,
    kvBytesPerTokenPerLayer,
  };
}

function nearestPower2(n: number): number {
  if (n <= 0) return 2048;
  const candidates = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
  return candidates.reduce((prev, curr) =>
    Math.abs(curr - n) < Math.abs(prev - n) ? curr : prev,
  );
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

export function registerEmbeddedModelHandlers(): void {
  // Subscribe to live stats + log events from the inference server and
  // broadcast them to all renderer windows so the Engine page stays live.
  addStatsListener((s) => broadcast(embeddedModelEvents.stats.channel, s));
  addLogListener((e) => broadcast(embeddedModelEvents.log.channel, e));

  ipcMain.handle("embedded-model:get-recent-logs", () => getRecentLogs());

  ipcMain.handle("embedded-model:get-status", async () => {
    const s = getServerStatus();
    return {
      ...s,
      modelName: s.modelPath
        ? (s.modelPath.split(/[/\\]/).pop() ?? null)
        : null,
      tokensGenerated: 0,
      lastTokensPerSec: 0,
    };
  });

  ipcMain.handle(
    "embedded-model:detect-gpu",
    async (_event, modelSizeMb?: number) => {
      return detectGpu(modelSizeMb);
    },
  );

  ipcMain.handle("embedded-model:get-gpu-stats", async () => {
    return getGpuStats();
  });

  ipcMain.handle("embedded-model:select-gguf", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select GGUF Model File",
      filters: [{ name: "GGUF Models", extensions: ["gguf"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(
    "embedded-model:get-model-info",
    async (_event, filePath: string) => {
      try {
        const gpuInfo = await detectGpu();
        return await computeModelInfo(
          filePath,
          gpuInfo.available ? gpuInfo.vramMb : 0,
        );
      } catch (err) {
        logger.error("Failed to compute model info:", err);
        const fileName = filePath.split(/[/\\]/).pop() ?? "";
        return {
          filePath,
          fileName,
          fileSizeMb: 0,
          paramBillions: null,
          quantization: "unknown",
          estimatedLayers: 32,
          layerSizeMb: 0,
          recommendedGpuLayers: 0,
          recommendedContextSize: 4096,
          maxSafeGpuLayers: 0,
        };
      }
    },
  );

  ipcMain.handle("embedded-model:load", async (_event, config) => {
    try {
      // Enrich config with GPU info and model geometry so the server
      // can calculate an accurate GPU layer count (vLLM-style).
      let vramMb = 0;
      let layerSizeMb = 200;
      let estimatedLayers = 64;

      try {
        const gpuInfo = await detectGpu();
        vramMb = gpuInfo.available ? gpuInfo.vramMb : 0;
      } catch {
        /* nvidia-smi may not be available */
      }

      try {
        if (config.modelPath) {
          const modelInfo = await computeModelInfo(config.modelPath, vramMb);
          layerSizeMb = modelInfo.layerSizeMb;
          estimatedLayers = modelInfo.estimatedLayers;
        }
      } catch {
        /* ignore — will fall back to defaults */
      }

      await loadModel({
        modelPath: config.modelPath,
        gpuMemoryUtilization: config.gpuMemoryUtilization ?? 0.8,
        contextSize: config.contextSize,
        batchSize: config.batchSize ?? 512,
        flashAttention: config.flashAttention ?? true,
        _vramMb: vramMb,
        _layerSizeMb: layerSizeMb,
        _estimatedLayers: estimatedLayers,
      });

      // Push sampling defaults to the engine so they take effect for chat requests.
      setDefaultSampling({
        temperature: config.temperature ?? 0.7,
        topP: config.topP ?? 0.95,
        topK: config.topK ?? 40,
        repeatPenalty: config.repeatPenalty ?? 1.1,
        seed: typeof config.seed === "number" ? config.seed : undefined,
      });

      writeSettings({ embeddedConfig: config } as any);
      logger.info("Model loaded and config saved");
      return { success: true };
    } catch (err) {
      logger.error("Failed to load model:", err);
      // The inference server already includes actionable tips in the error message
      // after exhausting all retry attempts (including CPU-only fallback).
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle("embedded-model:unload", async () => {
    try {
      await unloadModel();
      return { success: true };
    } catch (err) {
      logger.error("Failed to unload model:", err);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle("embedded-model:get-saved-config", () => {
    const settings = readSettings() as any;
    const cfg = settings.embeddedConfig ?? {};
    return {
      modelPath: cfg.modelPath ?? null,
      gpuMemoryUtilization: cfg.gpuMemoryUtilization ?? 0.8,
      contextSize: cfg.contextSize ?? 8192,
      batchSize: cfg.batchSize ?? 512,
      temperature: cfg.temperature ?? 0.7,
      topP: cfg.topP ?? 0.95,
      topK: cfg.topK ?? 40,
      repeatPenalty: cfg.repeatPenalty ?? 1.1,
      seed: cfg.seed ?? null,
      flashAttention: cfg.flashAttention ?? true,
    };
  });

  ipcMain.handle("embedded-model:save-config", (_event, config) => {
    const settings = readSettings() as any;
    const merged = { ...settings.embeddedConfig, ...config };
    writeSettings({ embeddedConfig: merged } as any);

    // If sampling-related fields changed, push them to the running engine immediately.
    setDefaultSampling({
      temperature: merged.temperature ?? 0.7,
      topP: merged.topP ?? 0.95,
      topK: merged.topK ?? 40,
      repeatPenalty: merged.repeatPenalty ?? 1.1,
      seed: typeof merged.seed === "number" ? merged.seed : undefined,
    });
  });
}
