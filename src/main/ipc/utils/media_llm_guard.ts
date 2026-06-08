import log from "electron-log";
import { getServerStatus } from "@/ipc/utils/embedded_inference_server";
import { getOrchestrator } from "@/main/ipc/utils/model_orchestrator";

const logger = log.scope("media-llm-guard");

/**
 * Returns true when the embedded LLM server currently holds a model — meaning a
 * media generation MUST swap it out (unload → generate → reload) to free
 * RAM/VRAM. When it returns true it has also informed the orchestrator of the
 * resident LLM so that `orchestrator.runMediaGeneration` can unload it before
 * generation and reload it afterwards.
 *
 * This replaces the unreliable `orchestrator.getStatus().state === "llm-loaded"`
 * check used by the media tools: in a normal Autopilot build the LLM is loaded
 * via the embedded inference server directly (not through the orchestrator), so
 * that state check returned false and the media tool called the backend
 * directly — loading a media model alongside the still-resident LLM and running
 * the machine out of memory (the Wan 2.1 14B OOM).
 */
export function ensureLlmSwapForMedia(): boolean {
  const status = getServerStatus();
  if (!status.modelPath) return false;
  getOrchestrator().informLlmAcquired({
    modelPath: status.modelPath,
    gpuLayers: status.gpuLayers ?? 0,
    contextSize: status.actualContextSize ?? 4096,
  });
  logger.info(
    `embedded LLM resident (${status.modelPath}); media generation will unload it first`,
  );
  return true;
}
