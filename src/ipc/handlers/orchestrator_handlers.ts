import {
  getOrchestrator,
  selectAvailableTiers,
  estimateFreedLlmVramMb,
  getLastLlmParams,
} from "@/main/ipc/utils/model_orchestrator";
import { initMediaDispatcher } from "@/main/ipc/utils/media_dispatcher";
import { getAvailableVramMb } from "@/main/ipc/utils/vram_accounting";
import { getCachedHardwareProfile } from "@/main/hardware/detect";
import { orchestratorContracts } from "../types/model_orchestrator";
import { createTypedHandler } from "./base";

export function registerOrchestratorHandlers(): void {
  initMediaDispatcher();
  createTypedHandler(orchestratorContracts.getStatus, async () => {
    return getOrchestrator().getStatus();
  });

  createTypedHandler(orchestratorContracts.acquireLlm, async (_e, params) => {
    await getOrchestrator().acquireLlm(params);
  });

  createTypedHandler(orchestratorContracts.runMedia, async (_e, request) => {
    return getOrchestrator().runMediaGeneration(request);
  });

  createTypedHandler(orchestratorContracts.releaseAll, async () => {
    await getOrchestrator().releaseAll();
  });

  createTypedHandler(orchestratorContracts.getAvailableTiers, async () => {
    const profile = await getCachedHardwareProfile();
    const live = await getAvailableVramMb(profile);
    const freed = estimateFreedLlmVramMb(getLastLlmParams());
    return selectAvailableTiers(live, freed);
  });
}
