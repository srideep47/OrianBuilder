import log from "electron-log";
import {
  getOrchestrator,
  type LlmLoadParams,
} from "@/main/ipc/utils/model_orchestrator";
import { getServerStatus, unloadModel } from "./embedded_inference_server";
import { releaseAllMediaAiModels } from "./media_ai_backend";

const logger = log.scope("exclusive-model-residency");

let sessionDepth = 0;
let operation = Promise.resolve();
let displacedLlm: LlmLoadParams | null = null;

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = operation.then(task, task);
  operation = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Enter a renderer-owned media session. Media Studio and 3D Studio issue
 * requests directly to the Python service, so they cannot rely on the chat
 * dispatcher's per-request swap. This session boundary removes the embedded
 * LLM before either page can intentionally generate media.
 */
export function beginExclusiveMediaSession(): Promise<void> {
  return serialize(async () => {
    sessionDepth += 1;
    if (sessionDepth > 1) return;

    const status = getServerStatus();
    if (!status.modelPath) {
      displacedLlm = null;
      return;
    }

    displacedLlm = {
      modelPath: status.modelPath,
      gpuLayers: status.gpuLayers ?? 0,
      contextSize: status.actualContextSize ?? 4096,
    };
    getOrchestrator().informLlmAcquired(displacedLlm);
    try {
      await unloadModel();
    } catch (err) {
      sessionDepth = 0;
      displacedLlm = null;
      throw err;
    }
    getOrchestrator().informLlmReleased();
    logger.info("exclusive media session: embedded LLM released");
  });
}

/** Leave a media session, clear Python weights, then restore the prior LLM. */
export function endExclusiveMediaSession(): Promise<void> {
  return serialize(async () => {
    sessionDepth = Math.max(0, sessionDepth - 1);
    if (sessionDepth > 0) return;

    await releaseAllMediaAiModels();
    if (!displacedLlm) return;

    const params = displacedLlm;
    displacedLlm = null;
    await getOrchestrator().acquireLlm(params);
    logger.info("exclusive media session: embedded LLM restored");
  });
}

/** Test-only reset for the serialized session state. */
export function _resetExclusiveMediaSessionForTests(): void {
  sessionDepth = 0;
  displacedLlm = null;
  operation = Promise.resolve();
}
