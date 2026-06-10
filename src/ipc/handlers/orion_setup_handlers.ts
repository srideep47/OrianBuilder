/**
 * IPC wiring for the Orion setup orchestrator (see main/orion_setup/orchestrator.ts).
 *
 * The orchestrator is backend-agnostic and unit-testable; this file injects the
 * real implementations (hardware detection, the media backend installer/downloader,
 * Engine-model detection, network join) and broadcasts every state change to all
 * windows as an `orion-setup:progress` event — the same fan-out pattern the media
 * queue uses, so progress survives renderer reloads and reaches whichever window is open.
 */
import fs from "node:fs";
import { BrowserWindow } from "electron";
import log from "electron-log";
import { createLoggedTypedHandler } from "./base";
import {
  orionSetupContracts,
  orionSetupEvents,
  type OrionSetupState,
} from "@/ipc/types/orion_setup";
import { getOrionSetupOrchestrator } from "@/main/orion_setup/orchestrator";
import { planModelDownloads } from "@/main/orion_setup/model_plan";
import { readSettings, writeSettings } from "@/main/settings";
import { refreshProfile } from "@/main/hardware/detect";
import {
  getMediaAiBackendStatus,
  installMediaAiDependenciesForBackend,
  downloadMediaAiModels,
  startMediaAiBackend,
  isMediaAiBackendHealthy,
} from "@/ipc/utils/media_ai_backend";
import type { MediaAiModelId } from "@/ipc/types/media_ai";
import { networkSwarm } from "@/main/network/swarm";

const logger = log.scope("orion-setup-handlers");
const handle = createLoggedTypedHandler(logger);

function broadcast(state: OrionSetupState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(orionSetupEvents.progress.channel, state);
    }
  }
}

export function registerOrionSetupHandlers(): void {
  const orch = getOrionSetupOrchestrator();

  orch.setDeps({
    refreshHardware: async () => {
      const hw = await refreshProfile();
      const backend = hw.bestMediaBackend ?? "cpu";
      const summary = `${hw.primaryGpu?.model ?? "CPU only"} · ${backend}`;
      return { backend, summary };
    },
    getMediaStatus: async () => {
      const s = await getMediaAiBackendStatus();
      return {
        venvExists: s.venvExists,
        depsInstalled: s.depsInstalled,
        healthy: s.healthy,
        downloadedModelIds: s.models
          .filter((m) => m.downloaded)
          .map((m) => m.id),
      };
    },
    resolveModelPlan: (downloadedModelIds) =>
      planModelDownloads(readSettings().orionMediaModels, downloadedModelIds),
    installDeps: async (backend) => {
      await installMediaAiDependenciesForBackend(
        backend === "cpu" ? undefined : backend,
      );
    },
    downloadModel: async (id, onLog) => {
      await downloadMediaAiModels([id as MediaAiModelId], onLog);
    },
    startBackend: async () => {
      await startMediaAiBackend();
    },
    waitHealthy: async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await isMediaAiBackendHealthy()) return true;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return isMediaAiBackendHealthy();
    },
    detectEngineModel: () => {
      const cfg = (
        readSettings() as { embeddedConfig?: { modelPath?: string } }
      ).embeddedConfig;
      const modelPath = cfg?.modelPath;
      return !!modelPath && fs.existsSync(modelPath);
    },
    enableNetwork: async () => {
      writeSettings({ orionNetworkEnabled: true } as Parameters<
        typeof writeSettings
      >[0]);
      await networkSwarm.start();
    },
    onUpdate: broadcast,
  });

  void orch.init();

  handle(orionSetupContracts.getState, async () => orch.getState());
  handle(orionSetupContracts.start, async (_e, params) => orch.start(params));
  handle(orionSetupContracts.resume, async () => orch.resume());
  handle(orionSetupContracts.cancel, async () => orch.cancel());
  handle(orionSetupContracts.retryStep, async (_e, { stepId }) =>
    orch.retryStep(stepId),
  );
  handle(orionSetupContracts.skipStep, async (_e, { stepId }) =>
    orch.skipStep(stepId),
  );
}
