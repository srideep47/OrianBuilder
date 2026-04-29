import { ipcMain, dialog } from "electron";
import log from "electron-log";
import {
  loadModel,
  unloadModel,
  getServerStatus,
  EmbeddedModelConfig,
} from "../utils/embedded_inference_server";
import { detectGpu } from "../utils/gpu_detection";
import { readSettings, writeSettings } from "../../main/settings";

const logger = log.scope("embedded-model-handler");

export function registerEmbeddedModelHandlers(): void {
  ipcMain.handle("embedded-model:get-status", async () => {
    return getServerStatus();
  });

  ipcMain.handle(
    "embedded-model:detect-gpu",
    async (_event, modelSizeMb?: number) => {
      return detectGpu(modelSizeMb);
    },
  );

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
    "embedded-model:load",
    async (_event, config: EmbeddedModelConfig) => {
      try {
        await loadModel(config);
        // Persist settings
        writeSettings({
          embeddedModelPath: config.modelPath,
          embeddedGpuLayers: config.gpuLayers,
          embeddedContextSize: config.contextSize,
        } as any);
        logger.info("Model loaded and settings saved");
        return { success: true };
      } catch (err) {
        logger.error("Failed to load model:", err);
        return { success: false, error: String(err) };
      }
    },
  );

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
    return {
      modelPath: settings.embeddedModelPath ?? null,
      gpuLayers: settings.embeddedGpuLayers ?? 99,
      contextSize: settings.embeddedContextSize ?? 8192,
    };
  });

  ipcMain.handle("embedded-model:auto-load-on-startup", async () => {
    const settings = readSettings() as any;
    const modelPath: string | undefined = settings.embeddedModelPath;
    if (!modelPath) return;
    try {
      await loadModel({
        modelPath,
        gpuLayers: settings.embeddedGpuLayers ?? 99,
        contextSize: settings.embeddedContextSize ?? 8192,
      });
      logger.info("Auto-loaded embedded model on startup");
    } catch (err) {
      logger.warn("Auto-load failed (model may have moved):", err);
    }
  });
}
