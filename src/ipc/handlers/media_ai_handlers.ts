import { mediaAiContracts } from "../types/media_ai";
import { createTypedHandler } from "./base";
import {
  downloadMediaAiModels,
  getMediaAiBackendStatus,
  installMediaAiDependencies,
  installMediaAiDependenciesForBackend,
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

  createTypedHandler(mediaAiContracts.downloadModels, async (_, params) => {
    const output = await downloadMediaAiModels(params.models);
    return { success: true, output };
  });

  createTypedHandler(mediaAiContracts.startBackend, async () => {
    startMediaAiBackend();
    return getMediaAiBackendStatus();
  });

  createTypedHandler(mediaAiContracts.stopBackend, async () => {
    stopMediaAiBackend();
    return getMediaAiBackendStatus();
  });
}
