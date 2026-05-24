import { mediaAiContracts } from "../types/media_ai";
import { createTypedHandler } from "./base";
import {
  cancelMediaAiDownload,
  deleteMediaAiModel,
  downloadMediaAiModels,
  getMediaAiBackendStatus,
  installMediaAiDependencies,
  installMediaAiDependenciesForBackend,
  installThreeDRuntimeOnly,
  isMediaAiDownloadActive,
  resetMediaAiSetup,
  startMediaAiBackend,
  stopMediaAiBackend,
} from "../utils/media_ai_backend";

export function registerMediaAiHandlers() {
  createTypedHandler(mediaAiContracts.getStatus, async () => {
    return getMediaAiBackendStatus();
  });

  createTypedHandler(mediaAiContracts.installDependencies, async () => {
    const output = await installMediaAiDependencies();
    return { success: true, output };
  });

  createTypedHandler(
    mediaAiContracts.installDependenciesForBackend,
    async (_e, params) => {
      try {
        const output = await installMediaAiDependenciesForBackend(
          params.backend,
        );
        return { success: true, output };
      } catch (err) {
        return {
          success: false,
          output: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  createTypedHandler(
    mediaAiContracts.installThreeDRuntime,
    async (_e, params) => {
      try {
        const output = await installThreeDRuntimeOnly(params.backend);
        return { success: true, output };
      } catch (err) {
        return {
          success: false,
          output: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  createTypedHandler(mediaAiContracts.downloadModels, async (_, params) => {
    const output = await downloadMediaAiModels(params.models);
    return { success: true, output };
  });

  createTypedHandler(mediaAiContracts.startBackend, async () => {
    await startMediaAiBackend();
    return getMediaAiBackendStatus();
  });

  createTypedHandler(mediaAiContracts.stopBackend, async () => {
    stopMediaAiBackend();
    return getMediaAiBackendStatus();
  });

  createTypedHandler(mediaAiContracts.cancelDownload, async () => {
    const wasActive = isMediaAiDownloadActive();
    cancelMediaAiDownload();
    return { cancelled: wasActive };
  });

  createTypedHandler(mediaAiContracts.deleteModel, async (_, params) => {
    await deleteMediaAiModel(params.modelId);
    return { deleted: true };
  });

  createTypedHandler(mediaAiContracts.resetSetup, async (_, params) => {
    return resetMediaAiSetup(params);
  });

  // Image proxy via main-process fetch (no CORS / Origin / Referer issues).
  // The renderer can't reliably load cloud images like Pollinations.ai because
  // Electron sends an unblockable Referer that some hosts reject. Routing
  // through Node here avoids all browser-side request mutation.
  createTypedHandler(mediaAiContracts.fetchCloudImage, async (_, params) => {
    const res = await fetch(params.url);
    if (!res.ok) {
      throw new Error(
        `Fetch failed for ${params.url}: HTTP ${res.status} ${res.statusText}`,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      base64: buf.toString("base64"),
      contentType: res.headers.get("content-type") || "image/jpeg",
    };
  });
}
