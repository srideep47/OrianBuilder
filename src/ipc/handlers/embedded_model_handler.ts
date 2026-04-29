import { ipcMain, dialog } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import log from "electron-log";
import {
  loadModel,
  unloadModel,
  getServerStatus,
} from "../utils/embedded_inference_server";
import { detectGpu } from "../utils/gpu_detection";
import { readSettings, writeSettings } from "../../main/settings";

const execFileAsync = promisify(execFile);
const logger = log.scope("embedded-model-handler");

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

export function registerEmbeddedModelHandlers(): void {
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

  ipcMain.handle("embedded-model:load", async (_event, config) => {
    try {
      await loadModel({
        modelPath: config.modelPath,
        gpuLayers: config.gpuLayers,
        contextSize: config.contextSize,
      });
      // Persist full config
      writeSettings({ embeddedConfig: config } as any);
      logger.info("Model loaded and config saved");
      return { success: true };
    } catch (err) {
      logger.error("Failed to load model:", err);
      return { success: false, error: String(err) };
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
      gpuLayers: cfg.gpuLayers ?? 99,
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
    writeSettings({
      embeddedConfig: { ...settings.embeddedConfig, ...config },
    } as any);
  });
}
